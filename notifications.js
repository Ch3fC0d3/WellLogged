const db = require('./db');

/**
 * Create an admin notification.
 * @param {Object} opts
 * @param {string} opts.type - Category, e.g. 'signup', 'order', 'payment'.
 * @param {string} opts.message - Human-readable message shown to the admin.
 * @param {string} [opts.link] - Optional in-app link (e.g. '/dashboard/admin').
 * @param {number} [opts.relatedId] - Optional related record id (user/log).
 * @returns {Promise<number>} The new notification id.
 */
function createNotification({ type, message, link = null, relatedId = null }) {
    return new Promise((resolve) => {
        db.run(
            `INSERT INTO notifications (type, message, link, related_id) VALUES (?, ?, ?, ?)`,
            [type, message, link, relatedId],
            function (err) {
                if (err) {
                    console.error('Failed to create notification:', err);
                    return resolve(null);
                }
                resolve(this.lastID);
            }
        );
    });
}

module.exports = { createNotification };
