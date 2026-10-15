import Link from 'next/link';

export default function ApplicationReceipt({ applicationId, emailStatus }: {
  applicationId: string;
  emailStatus: string;
}) {
  return (
    <main className="min-h-screen bg-[#050608] text-white flex items-center justify-center px-5">
      <section role="status" className="w-full max-w-xl rounded-2xl border border-cyan-400/20 bg-white/[0.02] p-8 text-center">
        <h1 className="text-3xl font-bold mb-4">Application Submitted!</h1>
        <p className="text-gray-300">Your application has been saved. Keep this ID for future reference.</p>
        <p className="mt-6 text-sm text-gray-400">Your Application ID</p>
        <p className="mt-2 mb-6 break-all select-all font-mono text-2xl font-bold text-cyan-300">{applicationId}</p>
        <p className="text-sm text-gray-300">
          {emailStatus === 'sent'
            ? 'Your confirmation was accepted by our email service. Please check your inbox and spam folder.'
            : 'Your application is saved, but we could not send the confirmation email. Keep your application ID and contact support; you do not need to submit again.'}
        </p>
        <Link href="/" className="mt-8 inline-block font-semibold text-cyan-300 hover:text-cyan-200">Return to Home</Link>
      </section>
    </main>
  );
}
