const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const adminPhone = process.env.ADMIN_PHONE_NUMBER;

let client = null;
if (accountSid && authToken) {
    try {
        client = twilio(accountSid, authToken);
    } catch (e) {
        console.error('Twilio init failed:', e.message);
    }
}

function sendAdminSMS(message) {
    if (!client || !fromNumber || !adminPhone) {
        console.warn('Twilio not configured; skipping SMS.');
        return Promise.resolve(null);
    }
    return client.messages.create({
        body: message,
        from: fromNumber,
        to: adminPhone
    }).then(msg => {
        console.log(`Admin SMS sent. SID: ${msg.sid}`);
        return msg;
    }).catch(err => {
        console.error('Failed to send admin SMS:', err.message);
        throw err;
    });
}

module.exports = { sendAdminSMS };
