const axios = require('axios');

const token = process.env.PUSHOVER_API_TOKEN;
const userKey = process.env.PUSHOVER_USER_KEY;
const dashboardUrl = process.env.ADMIN_DASHBOARD_URL || 'https://logdigitizing.ai/dashboard/admin';

async function sendPushoverUploadAlert({ clientName, filename, emergency = false }) {
    if (!token || !userKey) {
        console.warn('Pushover skipped: missing PUSHOVER_API_TOKEN or PUSHOVER_USER_KEY');
        return null;
    }

    const message = [
        'New Well Logged AI upload',
        '',
        `Client: ${clientName || 'Unknown'}`,
        `File: ${filename || 'Unknown'}`,
        '',
        'Check dashboard.'
    ].join('\n');

    const payload = {
        token: token,
        user: userKey,
        title: 'New Client File Uploaded',
        message: message,
        priority: emergency ? 2 : 1,
        sound: emergency ? 'siren' : 'pushover',
        url: dashboardUrl,
        url_title: 'Open Upload Dashboard'
    };

    if (emergency) {
        payload.retry = 60;   // repeat every 60 seconds
        payload.expire = 1800; // stop after 30 minutes
    }

    try {
        const response = await axios.post('https://api.pushover.net/1/messages.json', payload, { timeout: 10000 });
        if (response.status === 200) {
            console.log('Pushover alert sent.');
            return response.data;
        }
        console.error('Pushover failed:', response.status, response.data);
        return null;
    } catch (err) {
        console.error('Pushover error:', err.message);
        return null;
    }
}

module.exports = { sendPushoverUploadAlert };
