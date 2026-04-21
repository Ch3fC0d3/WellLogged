const db = require('./db');

const email = process.argv[2];

if (!email) {
    console.log('Usage: node make-admin.js <user-email>');
    process.exit(1);
}

db.run(`UPDATE users SET role = 'admin' WHERE email = ?`, [email], function(err) {
    if (err) {
        console.error('Error updating user:', err.message);
    } else if (this.changes === 0) {
        console.log(`No user found with email: ${email}`);
    } else {
        console.log(`Successfully promoted ${email} to admin!`);
    }
    process.exit(0);
});
