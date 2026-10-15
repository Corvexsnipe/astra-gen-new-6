import { NextRequest, NextResponse } from 'next/server';
import { readApplicationDocuments, UploadError } from '@/lib/application-documents';
import pool, { initializeDatabase, generateApplicationId, sendCustomerSupportApplicationEmail, sendAdminNotificationForCustomerSupport } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    console.log('Starting customer support application submission...');
    await initializeDatabase();
    console.log('Database initialized');

    const formData = await request.formData();

    // Extract all form fields
    const fullName = formData.get('fullName') as string;
    const age = parseInt(formData.get('age') as string);
    const country = formData.get('country') as string;
    const city = formData.get('city') as string;
    const email = formData.get('email') as string;
    const contactNumber = formData.get('contactNumber') as string;
    const languages = formData.get('languages') as string;
    const previousExperience = formData.get('previousExperience') as string;
    const hasHostingExperience = formData.get('hasHostingExperience') === 'true';
    const hostingExperienceDetails = formData.get('hostingExperienceDetails') as string;
    const dailyHours = parseInt(formData.get('dailyHours') as string);
    const weekendAvailability = formData.get('weekendAvailability') === 'true';
    const emergencyAvailability = formData.get('emergencyAvailability') === 'true';
    const handleAngryCustomer = formData.get('handleAngryCustomer') as string;
    const handleUnknownSolution = formData.get('handleUnknownSolution') as string;
    const prioritizeMultipleCustomers = formData.get('prioritizeMultipleCustomers') as string;
    const explainTechnicalIssue = formData.get('explainTechnicalIssue') as string;
    const minecraftServerCheck = formData.get('minecraftServerCheck') as string;
    const expectedSalary = formData.get('expectedSalary') as string;
    const whyHire = formData.get('whyHire') as string;
    const agreeToRules = formData.get('agreeToRules') === 'true';

    // File uploads - convert to base64
    const documents = await readApplicationDocuments(formData);

    // Validate required fields
    if (!fullName || !age || !country || !city || !email || !contactNumber || !languages || 
        !dailyHours || !handleAngryCustomer || !handleUnknownSolution || 
        !prioritizeMultipleCustomers || !explainTechnicalIssue || !minecraftServerCheck || 
        !expectedSalary || !whyHire || !agreeToRules) {
      return NextResponse.json(
        { error: 'All required fields must be filled' },
        { status: 400 }
      );
    }

    const applicationId = generateApplicationId();
    console.log('Generated application ID:', applicationId);

    // Convert files to base64
    const { experienceLetter: experienceLetterBase64, identityCard: identityCardBase64,
      identityCardFront: identityCardFrontBase64, passportPhoto: passportPhotoBase64 } = documents;

    const connection = await pool.getConnection();
    console.log('Database connection acquired');

    try {
      const [settings] = await connection.query('SELECT @@max_allowed_packet AS packetLimit');
      const packetLimit = (settings as { packetLimit: number }[])[0].packetLimit;
      const documentBytes = Object.values(documents).reduce((total, value) => total + (value?.length ?? 0), 0);
      if (documentBytes + 512 * 1024 > packetLimit) {
        throw new UploadError('These documents exceed the database upload limit. Please use smaller files.', 413);
      }
      await connection.query(
        `INSERT INTO customer_support_applications (
          application_id, full_name, age, country, city, email, contact_number,
          languages, previous_experience, has_hosting_experience, hosting_experience_details,
          experience_letter_base64, daily_hours, weekend_availability, emergency_availability,
          handle_angry_customer, handle_unknown_solution, prioritize_multiple_customers,
          explain_technical_issue, minecraft_server_check, expected_salary,
          identity_card_base64, passport_photo_base64, identity_card_front_base64, why_hire, agree_to_rules
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          applicationId, fullName, age, country, city, email, contactNumber,
          languages, previousExperience, hasHostingExperience, hostingExperienceDetails,
          experienceLetterBase64, dailyHours, weekendAvailability, emergencyAvailability,
          handleAngryCustomer, handleUnknownSolution, prioritizeMultipleCustomers,
          explainTechnicalIssue, minecraftServerCheck, expectedSalary,
          identityCardBase64, passportPhotoBase64, identityCardFrontBase64, whyHire, agreeToRules
        ]
      );
      console.log('Application saved to database');
    } finally {
      connection.release();
    }

    let emailStatus: 'sent' | 'failed' = 'failed';
    // Send email notification to applicant
    try {
      await sendCustomerSupportApplicationEmail(fullName, email, applicationId);
      emailStatus = 'sent';
      console.log('Email sent successfully to applicant');
    } catch (emailError) {
      console.error('Email sending error to applicant:', emailError);
      // Email failure is logged but does not prevent application submission
      // The application is already saved to the database
    }

    // Send notification to admin
    try {
      await sendAdminNotificationForCustomerSupport(fullName, email, applicationId);
      console.log('Admin notification sent successfully');
    } catch (emailError) {
      console.error('Admin notification sending error:', emailError);
      // Email failure is logged but does not prevent application submission
      // The application is already saved to the database
    }

    return NextResponse.json(
      {
        message: 'Application submitted successfully',
        applicationId,
        emailStatus
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const databaseError = error as { code?: string; errno?: number };
    console.error('Error submitting customer support application:', { code: databaseError.code, errno: databaseError.errno });
    return NextResponse.json(
      { error: 'Failed to submit application' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    await initializeDatabase();

    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      'SELECT * FROM customer_support_applications ORDER BY created_at DESC'
    );
    connection.release();

    return NextResponse.json({ applications: rows });
  } catch (error) {
    console.error('Error fetching applications:', error);
    return NextResponse.json(
      { error: 'Failed to fetch applications' },
      { status: 500 }
    );
  }
}
