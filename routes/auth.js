const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { sendEmail } = require('../email');
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...' ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const db = require('../db');
const router = express.Router();

router.post('/signup', async (req, res) => {
    const { name, email, password, company, address } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        // Hash password
        const password_hash = await bcrypt.hash(password, 10);
        
        // Create Stripe Customer
        let stripeCustomerId = null;
        if (stripe) {
            const customerOptions = {
                email,
                name,
                metadata: { company }
            };
            if (address) {
                customerOptions.address = {
                    line1: address,
                };
            }
            const customer = await stripe.customers.create(customerOptions);
            stripeCustomerId = customer.id;
        }

        // Insert into DB
        const sql = `INSERT INTO users (name, email, password_hash, company, address, stripe_customer_id) VALUES (?, ?, ?, ?, ?, ?)`;
        db.run(sql, [name, email, password_hash, company || null, address || null, stripeCustomerId], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ error: 'Email already exists' });
                }
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Login user after signup
            req.session.userId = this.lastID;
            req.session.email = email;
            req.session.role = 'customer';
            
            req.session.save((err) => {
                if (err) return res.status(500).json({ error: 'Session error' });
                res.status(201).json({ message: 'User created successfully', user: { id: this.lastID, email, name } });
            });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });
        
        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.role = user.role;
        req.session.stripeCustomerId = user.stripe_customer_id;
        
        req.session.save((err) => {
            if (err) {
                console.error('[Login] Failed to save session:', err);
                return res.status(500).json({ error: 'Session error' });
            }
            console.log(`[Login] Session saved. Session ID: ${req.sessionID}, User ID: ${req.session.userId}`);
            res.json({ message: 'Logged in successfully', user: { id: user.id, name: user.name, email: user.email } });
        });
    });
});

router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Failed to logout' });
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    db.get(`SELECT id, name FROM users WHERE email = ?`, [email], (err, user) => {
        if (err || !user) {
            // Send success anyway to prevent email enumeration
            return res.json({ message: 'If an account exists with that email, a reset link was sent.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000); // 1 hour

        db.run(`UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?`, [token, expiry.toISOString(), user.id], (err) => {
            if (err) {
                console.error('Failed to save reset token:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
            
            sendEmail({
                to: email,
                subject: 'Log Digitizing - Password Reset Request',
                text: `Hi ${user.name || 'there'},\n\nYou requested a password reset. Click the link below to set a new password:\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email. The link will expire in 1 hour.\n\nThank you,\nThe Log Digitizing Team`,
                html: `<p>Hi ${user.name || 'there'},</p><p>You requested a password reset. Click the link below to set a new password:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email. The link will expire in 1 hour.</p><p>Thank you,<br>The Log Digitizing Team</p>`
            }).catch(e => console.error('Failed to send reset email:', e));

            res.json({ message: 'If an account exists with that email, a reset link was sent.' });
        });
    });
});

router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });

    db.get(`SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > CURRENT_TIMESTAMP`, [token], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });

        try {
            const hash = await bcrypt.hash(password, 10);
            db.run(`UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?`, [hash, user.id], (err) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                res.json({ message: 'Password updated successfully. You can now log in.' });
            });
        } catch (e) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });
});

router.get('/me', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    db.get(`SELECT id, name, email, company, address, role, email_notifications FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    });
});

router.put('/me', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { name, email, company, address, password, email_notifications } = req.body;
    
    try {
        let sql = `UPDATE users SET name = ?, email = ?, company = ?, address = ?, email_notifications = ?`;
        let params = [name, email, company || null, address || null, email_notifications !== undefined ? email_notifications : 1];
        
        if (password) {
            const hash = await bcrypt.hash(password, 10);
            sql += `, password_hash = ?`;
            params.push(hash);
        }
        
        sql += ` WHERE id = ?`;
        params.push(req.session.userId);
        
        db.run(sql, params, function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ error: 'Email already in use' });
                }
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ message: 'Profile updated successfully' });
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
