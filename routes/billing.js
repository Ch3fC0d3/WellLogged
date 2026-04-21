const express = require('express');
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...' ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const db = require('../db');
const router = express.Router();

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// Summary route
router.get('/summary', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    // Fetch subscription details and recent invoices
    db.get(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId], (err, sub) => {
        db.all(`SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [userId], (err2, invoices) => {
            res.json({
                subscription: sub || null,
                invoices: invoices || []
            });
        });
    });
});

// Create Portal Session
router.post('/create-portal-session', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        // Need to get the Stripe Customer ID
        db.get(`SELECT stripe_customer_id FROM users WHERE id = ?`, [userId], async (err, user) => {
            if (err || !user) return res.status(500).json({ error: 'User not found' });
            
            if (!user.stripe_customer_id || !stripe) {
                return res.status(400).json({ error: 'No Stripe customer linked to this account or Stripe is not configured.' });
            }

            const portalSession = await stripe.billingPortal.sessions.create({
                customer: user.stripe_customer_id,
                return_url: `${req.protocol}://${req.get('host')}/dashboard/billing.html`,
            });
            
            res.json({ url: portalSession.url });
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
