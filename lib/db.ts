import mysql from 'mysql2/promise';
import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL || 'mysql://mysql:3Qed32td8bS5Jw1G12v9Ydrpd4sCriNb4GFROuueQ2SneGqVA48KFnxwBtUk7XjG@edkiolselorf4b4ohoocpjaf:3306/default',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const emailPrefix = ['HOST', 'PORT', 'USER', 'PASS', 'FROM'].some(key => process.env[`SMTP_${key}`]) ? 'SMTP' : 'EMAIL';
const emailConfig = {
  host: process.env[`${emailPrefix}_HOST`]?.trim(),
  port: Number(process.env[`${emailPrefix}_PORT`]),
  user: process.env[`${emailPrefix}_USER`]?.trim(),
  pass: process.env[`${emailPrefix}_PASS`],
  from: process.env[`${emailPrefix}_FROM`]?.trim(),
};

// Validate email configuration at startup
const validateEmailConfig = () => {
  const requiredVars = ['HOST', 'PORT', 'USER', 'PASS', 'FROM'].map(key => `${emailPrefix}_${key}`);
  const missing = requiredVars.filter(varName => !process.env[varName]?.trim());

  if (missing.length > 0) {
    console.error('Email configuration error: Missing required environment variables:', missing.join(', '));
    console.error('Email sending will be disabled. Please configure the following environment variables:');
    missing.forEach(varName => console.error(`  - ${varName}`));
    return false;
  }
  if (![465, 587].includes(emailConfig.port)) {
    console.error('Email configuration error: SMTP port must be 465 or 587.');
    return false;
  }

  // Log that email config is valid (without exposing values)
  console.log('Email configuration validated:', { source: emailPrefix, usernamePresent: Boolean(emailConfig.user), passwordPresent: Boolean(emailConfig.pass), senderPresent: Boolean(emailConfig.from) });
  return true;
};

// Create transporter with validation
const emailConfigValid = validateEmailConfig();

const smtpTransport = nodemailer.createTransport({
  host: emailConfig.host,
  port: emailConfig.port || 587,
  secure: emailConfig.port === 465, // Use STARTTLS for port 587
  requireTLS: emailConfig.port === 587,
  auth: {
    user: emailConfig.user,
    pass: emailConfig.pass,
  },
  debug: false,
  logger: false,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

// Verify on first send, sharing successful verification across subsequent sends.
let smtpVerification: Promise<true> | undefined;
const transporter = {
  async sendMail(options: SendMailOptions) {
    if (!emailConfigValid) throw new Error('SMTP configuration is incomplete. Check server environment variable diagnostics.');
    try {
      smtpVerification ??= smtpTransport.verify().catch((error) => {
        smtpVerification = undefined;
        throw error;
      });
      await smtpVerification;
      const info = await smtpTransport.sendMail({ ...options, from: emailConfig.from });
      if (!info.accepted?.length || info.rejected?.length) {
        throw Object.assign(new Error('Recipient rejected'), { code: 'EENVELOPE' });
      }
      return info;
    } catch (error) {
      const smtpError = error as { code?: string; responseCode?: number };
      const category = smtpError.code === 'EAUTH' ? 'authentication' : smtpError.code === 'EENVELOPE' ? 'recipient rejection' : 'connection or SMTP delivery';
      console.error('SMTP delivery failed:', { category, responseCode: smtpError.responseCode });
      throw new Error(`SMTP ${category} failure. Check server configuration and provider logs.`);
    }
  },
};

let databaseInitialization: Promise<void> | undefined;

export function initializeDatabase() {
  databaseInitialization ??= initializeSchema().catch((error) => {
    databaseInitialization = undefined;
    throw error;
  });
  return databaseInitialization;
}

async function initializeSchema() {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [locks] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT GET_LOCK(CONCAT('caspian-schema-', LEFT(DATABASE(), 40)), 30) AS acquired"
    );
    locked = locks[0]?.acquired === 1;
    if (!locked) throw new Error('Database schema initialization is busy. Please retry.');
    console.log('Database connection established');

    // Create staff_applications table if not exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS staff_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('staff_applications table checked/created');

    // Check if application_id column exists, add if not
    const [columns] = await connection.query<mysql.RowDataPacket[]>(`
      SHOW COLUMNS FROM staff_applications LIKE 'application_id'
    `);

    if (columns.length === 0) {
      // Add column as nullable first
      await connection.query(`
        ALTER TABLE staff_applications
        ADD COLUMN application_id VARCHAR(20) NULL AFTER id
      `);

      // Update existing rows with application IDs
      await connection.query(`
        UPDATE staff_applications
        SET application_id = CONCAT('CAS-', LPAD(id, 6, '0'))
        WHERE application_id IS NULL
      `);

      // Now make it NOT NULL and UNIQUE
      await connection.query(`
        ALTER TABLE staff_applications
        MODIFY COLUMN application_id VARCHAR(20) NOT NULL,
        ADD UNIQUE INDEX (application_id)
      `);

      console.log('Added application_id column to staff_applications table');
    }

    // Create customer_support_applications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_support_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        application_id VARCHAR(20) NOT NULL UNIQUE,
        full_name VARCHAR(255) NOT NULL,
        age INT NOT NULL,
        country VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        contact_number VARCHAR(20) NOT NULL,
        languages TEXT NOT NULL,
        previous_experience TEXT,
        has_hosting_experience BOOLEAN DEFAULT FALSE,
        hosting_experience_details TEXT,
        experience_letter_base64 MEDIUMTEXT,
        daily_hours INT NOT NULL,
        weekend_availability BOOLEAN DEFAULT FALSE,
        emergency_availability BOOLEAN DEFAULT FALSE,
        handle_angry_customer TEXT NOT NULL,
        handle_unknown_solution TEXT NOT NULL,
        prioritize_multiple_customers TEXT NOT NULL,
        explain_technical_issue TEXT NOT NULL,
        minecraft_server_check TEXT NOT NULL,
        expected_salary VARCHAR(50) NOT NULL,
        identity_card_base64 MEDIUMTEXT,
        passport_photo_base64 MEDIUMTEXT,
        why_hire TEXT NOT NULL,
        identity_card_front_base64 MEDIUMTEXT,
        agree_to_rules BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('customer_support_applications table checked/created');

    // Create sales_applications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sales_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        application_id VARCHAR(20) NOT NULL UNIQUE,
        full_name VARCHAR(255) NOT NULL,
        age INT NOT NULL,
        country VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        contact_number VARCHAR(20) NOT NULL,
        languages TEXT NOT NULL,
        previous_experience TEXT NOT NULL,
        hosting_experience TEXT NOT NULL,
        experience_letter_base64 MEDIUMTEXT,
        daily_hours VARCHAR(50) NOT NULL,
        weekend_availability BOOLEAN DEFAULT FALSE,
        emergency_availability BOOLEAN DEFAULT FALSE,
        expected_salary VARCHAR(50) NOT NULL,
        convince_customer TEXT NOT NULL,
        expensive_response TEXT NOT NULL,
        minecraft_server_info TEXT NOT NULL,
        ram_cpu_difference TEXT NOT NULL,
        lag_diagnosis TEXT NOT NULL,
        identity_card_base64 MEDIUMTEXT,
        passport_photo_base64 MEDIUMTEXT,
        why_hire TEXT NOT NULL,
        identity_card_front_base64 MEDIUMTEXT,
        agree_to_rules BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('sales_applications table checked/created');

    // Create technical_support_applications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS technical_support_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        application_id VARCHAR(20) NOT NULL UNIQUE,
        full_name VARCHAR(255) NOT NULL,
        age INT NOT NULL,
        country VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        contact_number VARCHAR(20) NOT NULL,
        languages TEXT NOT NULL,
        documents_availability VARCHAR(50) NOT NULL,
        compensation VARCHAR(50) NOT NULL,
        pterodactyl_panel TEXT NOT NULL,
        paymenter_panel TEXT NOT NULL,
        proxmox TEXT NOT NULL,
        vmware TEXT NOT NULL,
        linux TEXT NOT NULL,
        developing_ideas TEXT NOT NULL,
        identity_card_base64 MEDIUMTEXT,
        passport_photo_base64 MEDIUMTEXT,
        agree_to_rules BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('technical_support_applications table checked/created');

    for (const table of ['customer_support_applications', 'sales_applications', 'technical_support_applications']) {
      const [columns] = await connection.query<mysql.RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\``);
      const documentColumns = ['identity_card_base64', 'passport_photo_base64'];
      if (table !== 'technical_support_applications') documentColumns.push('experience_letter_base64', 'identity_card_front_base64');
      const alterations: string[] = [];
      for (const name of documentColumns) {
        const column = columns.find((column) => column.Field === name);
        if (!column) alterations.push(`ADD COLUMN \`${name}\` MEDIUMTEXT NULL`);
        else if (!['mediumtext', 'longtext'].includes(column.Type.toLowerCase())) {
          alterations.push(`MODIFY COLUMN \`${name}\` MEDIUMTEXT NULL`);
        }
      }
      const discord = columns.find((column) => column.Field === 'discord_username');
      if (discord?.Null === 'NO') alterations.push('MODIFY COLUMN discord_username VARCHAR(100) NULL');
      if (alterations.length) {
        await connection.query(`ALTER TABLE \`${table}\` ${alterations.join(', ')}`);
        console.log('Application schema updated:', table);
      }
    }
    console.log('Database initialized successfully');
  } catch (error) {
    const databaseError = error as { code?: string; errno?: number };
    console.error('Error initializing database:', { code: databaseError.code, errno: databaseError.errno });
    throw error;
  } finally {
    try {
      if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('caspian-schema-', LEFT(DATABASE(), 40)))");
    } finally {
      connection.release();
    }
  }
}

export function generateApplicationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `CAS-${timestamp}-${random}`.toUpperCase();
}

export async function sendStaffApplicationEmail(name: string, email: string, message: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: process.env.ADMIN_EMAIL || 'caspiannode@gmail.com',
      subject: 'New Staff Application Received',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">New Staff Application</h2>
          <p style="color: #666;">A new staff application has been submitted:</p>

          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Message:</strong></p>
            <p style="white-space: pre-wrap; color: #555;">${message}</p>
          </div>

          <p style="color: #999; font-size: 12px;">This is an automated email from Caspian Host Staff Application Form.</p>
        </div>
      `,
    });
    console.log('Staff application email sent successfully to admin');
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending staff application email:', error);
    throw error;
  }
}

export async function sendCustomerSupportApplicationEmail(fullName: string, email: string, applicationId: string) {
  // Check if email configuration is valid before attempting to send
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: email,
      subject: 'Your Customer Support Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0a;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #00d4ff; font-size: 32px; margin: 0;">Caspian Host</h1>
            <p style="color: #888; font-size: 14px; margin: 5px 0 0 0;">Premium Game Hosting</p>
          </div>

          <div style="background: #1a1a1a; padding: 30px; border-radius: 10px; border: 1px solid #333;">
            <h2 style="color: #fff; margin-top: 0;">Application Received!</h2>
            <p style="color: #ccc; line-height: 1.6;">
              Thank you for applying to join the Caspian Host Customer Support team. We have received your application and will review it shortly.
            </p>

            <div style="background: #0f0f0f; padding: 20px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #00d4ff;">
              <p style="color: #888; font-size: 14px; margin: 0 0 5px 0;">Your Application ID:</p>
              <p style="color: #00d4ff; font-size: 24px; font-weight: bold; margin: 0; letter-spacing: 1px;">${applicationId}</p>
            </div>

            <p style="color: #ccc; line-height: 1.6;">
              Please save this Application ID for future reference. Our team will contact you via email if your application progresses to the next stage.
            </p>

            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
              <p style="color: #888; font-size: 14px; margin: 0;">
                If you have any questions, feel free to contact us at <a href="mailto:support@caspianhost.com" style="color: #00d4ff;">support@caspianhost.com</a>
              </p>
            </div>
          </div>

          <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
            <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Caspian Host. All rights reserved.</p>
          </div>
        </div>
      `,
    });
    console.log('Customer support application email sent successfully to:', email);
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending customer support application email:', error);

    // Detailed error logging without exposing credentials
    if (error instanceof Error) {
      if (error.message.includes('Missing credentials')) {
        console.error('Authentication failed: SMTP username or password is missing or incorrect');
      } else if (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNREFUSED')) {
        console.error('Connection failed: Cannot connect to SMTP server. Check host and port.');
      } else if (error.message.includes('550') || error.message.includes('rejected')) {
        console.error('Email rejected: Recipient address may be invalid or rejected by server');
      } else {
        console.error('Email error:', error.message);
      }
    }

    throw error; // Re-throw to allow caller to handle the error
  }
}

export async function sendSalesApplicationEmail(fullName: string, email: string, applicationId: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: email,
      subject: 'Your Sales Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0a;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #00d4ff; font-size: 32px; margin: 0;">Caspian Host</h1>
            <p style="color: #888; font-size: 14px; margin: 5px 0 0 0;">Premium Game Hosting</p>
          </div>

          <div style="background: #1a1a1a; padding: 30px; border-radius: 10px; border: 1px solid #333;">
            <h2 style="color: #fff; margin-top: 0;">Application Received!</h2>
            <p style="color: #ccc; line-height: 1.6;">
              Thank you for applying to join the Caspian Host Sales team. We have received your application and will review it shortly.
            </p>

            <div style="background: #0f0f0f; padding: 20px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #00d4ff;">
              <p style="color: #888; font-size: 14px; margin: 0 0 5px 0;">Your Application ID:</p>
              <p style="color: #00d4ff; font-size: 24px; font-weight: bold; margin: 0; letter-spacing: 1px;">${applicationId}</p>
            </div>

            <p style="color: #ccc; line-height: 1.6;">
              Please save this Application ID for future reference. Our team will contact you via email if your application progresses to the next stage.
            </p>

            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
              <p style="color: #888; font-size: 14px; margin: 0;">
                If you have any questions, feel free to contact us at <a href="mailto:support@caspianhost.com" style="color: #00d4ff;">support@caspianhost.com</a>
              </p>
            </div>
          </div>

          <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
            <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Caspian Host. All rights reserved.</p>
          </div>
        </div>
      `,
    });
    console.log('Sales application email sent successfully to:', email);
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending sales application email:', error);
    throw error;
  }
}

export async function sendStaffApplicationConfirmationEmail(name: string, email: string, applicationId: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: email,
      subject: 'Your Staff Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0a;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #00d4ff; font-size: 32px; margin: 0;">Caspian Host</h1>
            <p style="color: #888; font-size: 14px; margin: 5px 0 0 0;">Premium Game Hosting</p>
          </div>

          <div style="background: #1a1a1a; padding: 30px; border-radius: 10px; border: 1px solid #333;">
            <h2 style="color: #fff; margin-top: 0;">Application Received!</h2>
            <p style="color: #ccc; line-height: 1.6;">
              Thank you for applying to join the Caspian Host team. We have received your application and will review it shortly.
            </p>

            <div style="background: #0f0f0f; padding: 20px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #00d4ff;">
              <p style="color: #888; font-size: 14px; margin: 0 0 5px 0;">Your Application ID:</p>
              <p style="color: #00d4ff; font-size: 24px; font-weight: bold; margin: 0; letter-spacing: 1px;">${applicationId}</p>
            </div>

            <p style="color: #ccc; line-height: 1.6;">
              Please save this Application ID for future reference. Our team will contact you via email if your application progresses to the next stage.
            </p>

            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
              <p style="color: #888; font-size: 14px; margin: 0;">
                If you have any questions, feel free to contact us at <a href="mailto:support@caspianhost.com" style="color: #00d4ff;">support@caspianhost.com</a>
              </p>
            </div>
          </div>

          <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
            <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Caspian Host. All rights reserved.</p>
          </div>
        </div>
      `,
    });
    console.log('Staff application confirmation email sent successfully to:', email);
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending staff application confirmation email:', error);
    throw error;
  }
}

export async function sendAdminNotificationForCustomerSupport(fullName: string, email: string, applicationId: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: process.env.ADMIN_EMAIL || 'caspiannode@gmail.com',
      subject: 'New Customer Support Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">New Customer Support Application</h2>
          <p style="color: #666;">A new customer support application has been submitted:</p>

          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Application ID:</strong> ${applicationId}</p>
            <p><strong>Name:</strong> ${fullName}</p>
            <p><strong>Email:</strong> ${email}</p>
          </div>

          <p style="color: #999; font-size: 12px;">This is an automated email from Caspian Host Application System.</p>
        </div>
      `,
    });
    console.log('Admin notification sent for customer support application');
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending admin notification for customer support:', error);
    throw error;
  }
}

export async function sendAdminNotificationForSales(fullName: string, email: string, applicationId: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: process.env.ADMIN_EMAIL || 'caspiannode@gmail.com',
      subject: 'New Sales Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">New Sales Application</h2>
          <p style="color: #666;">A new sales application has been submitted:</p>

          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Application ID:</strong> ${applicationId}</p>
            <p><strong>Name:</strong> ${fullName}</p>
            <p><strong>Email:</strong> ${email}</p>
          </div>

          <p style="color: #999; font-size: 12px;">This is an automated email from Caspian Host Application System.</p>
        </div>
      `,
    });
    console.log('Admin notification sent for sales application');
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending admin notification for sales:', error);
    throw error;
  }
}

export async function sendTechnicalSupportApplicationEmail(fullName: string, email: string, applicationId: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: email,
      subject: 'Technical Support Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">Application Received!</h1>
          </div>
          
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
            <p style="color: #333; font-size: 16px; margin-bottom: 20px;">Dear ${fullName},</p>
            
            <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
              Thank you for applying for the Technical Support position at Caspian Host! 
              We have successfully received your application.
            </p>
            
            <div style="background: white; padding: 20px; border-left: 4px solid #667eea; margin: 20px 0;">
              <p style="margin: 0; color: #333;"><strong>Application ID:</strong> ${applicationId}</p>
            </div>
            
            <div style="background: #fff3cd; padding: 20px; border-left: 4px solid #ffc107; margin: 20px 0;">
              <p style="margin: 0; color: #856404;"><strong>Important:</strong> Your interview will be taken live on Google Meet where your skills will be tested. Please prepare accordingly.</p>
            </div>
            
            <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
              Our team will review your application and contact you soon regarding the next steps in our hiring process.
            </p>
            
            <p style="color: #666; line-height: 1.6; margin-bottom: 10px;">
              <strong>What's next?</strong><br>
              • Your application will be reviewed by our hiring team<br>
              • If shortlisted, you will be contacted for a live interview on Google Meet<br>
              • Your technical skills will be tested during the interview
            </p>
            
            <p style="color: #999; font-size: 12px; margin-top: 30px;">
              If you have any questions, please don't hesitate to contact us.
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
            <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Caspian Host. All rights reserved.</p>
          </div>
        </div>
      `,
    });
    console.log('Technical support application confirmation email sent successfully to:', email);
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending technical support application email:', error);
    throw error;
  }
}

export async function sendAdminNotificationForTechnicalSupport(fullName: string, email: string, applicationId: string) {
  if (!emailConfigValid) {
    console.error('Cannot send email: Email configuration is invalid or missing required environment variables');
    throw new Error('Email configuration is invalid. Please check server logs for details.');
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'work@caspianhost.com',
      to: process.env.ADMIN_EMAIL || 'caspiannode@gmail.com',
      subject: 'New Technical Support Application Received - Caspian Host',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">New Technical Support Application</h2>
          <p style="color: #666;">A new technical support application has been submitted:</p>

          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Application ID:</strong> ${applicationId}</p>
            <p><strong>Name:</strong> ${fullName}</p>
            <p><strong>Email:</strong> ${email}</p>
          </div>

          <p style="color: #999; font-size: 12px;">This is an automated email from Caspian Host Application System.</p>
        </div>
      `,
    });
    console.log('Admin notification sent for technical support application');
    console.log('Email ID:', info.messageId);
  } catch (error) {
    console.error('Error sending admin notification for technical support:', error);
    throw error;
  }
}

export default pool;
