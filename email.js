const nodemailer = require('nodemailer');

const port = parseInt(process.env.MAIL_PORT || process.env.SMTP_PORT || '587');
// Port 465 uses direct TLS (secure:true); port 587 uses STARTTLS (secure:false, auto-upgrade)
const secure = port === 465 || port === 993;

const transporter = nodemailer.createTransport({
    host: process.env.MAIL_SERVER || process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    auth: {
        user: process.env.MAIL_USERNAME || process.env.SMTP_USER,
        pass: process.env.MAIL_PASSWORD || process.env.SMTP_PASS,
    },
    debug: true,
    logger: true
});

async function sendEmail({ to, subject, text, html, attachments = [] }) {
    const info = await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@logdigitizing.ai',
        to,
        subject,
        text,
        html,
        attachments,
    });
    console.log('Email sent:', info.messageId);
    return info;
}

module.exports = { sendEmail, transporter };
