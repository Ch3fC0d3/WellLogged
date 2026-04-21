const express = require('express');
const bcrypt = require('bcrypt');
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...' ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const db = require('../db');
const router = express.Router();

router.post('/signup', async (req, res) => {
    const { name, email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        // Hash password
        const password_hash = await bcrypt.hash(password, 10);
        
        // Create Stripe Customer
        let stripeCustomerId = null;
        if (stripe) {
            const customer = await stripe.customers.create({
                email,
                name
            });
            stripeCustomerId = customer.id;
        }

        // Insert into DB
        const sql = `INSERT INTO users (name, email, password_hash, stripe_customer_id) VALUES (?, ?, ?, ?)`;
        db.run(sql, [name, email, password_hash, stripeCustomerId], function(err) {
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
            
            res.status(201).json({ message: 'User created successfully', user: { id: this.lastID, email, name } });
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
        
        res.json({ message: 'Logged in successfully', user: { id: user.id, name: user.name, email: user.email } });
    });
});

router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Failed to logout' });
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

router.get('/me', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    db.get(`SELECT id, name, email, role FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    });
});

module.exports = router;
