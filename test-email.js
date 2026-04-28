require('dotenv').config();
const { sendEmail } = require('./email');

(async () => {
    try {
        const to = 'gabriel@pellegrini.us';
        await sendEmail({
            to,
            subject: 'New Project Submitted: Smith Well #1',
            text: 'Hello Admin,\n\nA new project was just submitted by a user on Log Digitizing.\nPlease review it in the dashboard.',
            html: `<p>Hello Admin,</p><p>A new project was just submitted by a user on <strong>Log Digitizing</strong>.</p><p>Please review it in the dashboard.</p>`,
        });
        console.log(`Test email sent successfully to ${to}`);
        process.exit(0);
    } catch (err) {
        console.error('Failed to send test email:', err.message);
        process.exit(1);
    }
})();
