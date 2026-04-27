require('dotenv').config();
const { sendEmail } = require('./email');

(async () => {
    try {
        const to = process.env.TEST_EMAIL_TO || 'hello@logdigitizing.ai';
        await sendEmail({
            to,
            subject: 'Test Email from Log Digitizing',
            text: 'This is a test email from the Log Digitizing platform. If you received this, the email system is working correctly.',
            html: `<p>This is a test email from the <strong>Log Digitizing</strong> platform.</p><p>If you received this, the email system is working correctly.</p>`,
        });
        console.log(`Test email sent successfully to ${to}`);
        process.exit(0);
    } catch (err) {
        console.error('Failed to send test email:', err.message);
        process.exit(1);
    }
})();
