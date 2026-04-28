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

// Create Checkout Session for a Log
router.post('/checkout/log/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const logId = req.params.id;

        db.get(`SELECT * FROM logs WHERE id = ? AND user_id = ?`, [logId, userId], async (err, log) => {
            if (err || !log) return res.status(404).json({ error: 'Log not found' });
            if (log.status === 'paid' || log.status === 'delivered') return res.status(400).json({ error: 'Log is already paid.' });
            
            const amountDue = log.amount_due;
            if (!amountDue || amountDue <= 0) {
                return res.status(400).json({ error: 'Amount due is not set for this log.' });
            }

            if (!stripe) {
                return res.status(500).json({ error: 'Stripe is not configured on the server.' });
            }

            // Get customer ID
            db.get(`SELECT stripe_customer_id, email FROM users WHERE id = ?`, [userId], async (err, user) => {
                const sessionConfig = {
                    payment_method_types: ['card'],
                    line_items: [
                        {
                            price_data: {
                                currency: 'usd',
                                product_data: {
                                    name: `Digitized Log: ${log.title}`,
                                    description: `${log.footage || 0} feet, ${log.curves || 1} curve(s)`
                                },
                                unit_amount: amountDue, // Amount in cents
                            },
                            quantity: 1,
                        },
                    ],
                    mode: 'payment',
                    success_url: `${req.protocol}://${req.get('host')}/dashboard/logs/${log.id}?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${req.protocol}://${req.get('host')}/dashboard/logs/${log.id}`,
                    metadata: {
                        logId: log.id.toString(),
                        userId: userId.toString()
                    }
                };

                if (user && user.stripe_customer_id) {
                    sessionConfig.customer = user.stripe_customer_id;
                } else if (user && user.email) {
                    sessionConfig.customer_email = user.email;
                }

                const session = await stripe.checkout.sessions.create(sessionConfig);
                res.json({ url: session.url });
            });
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Verify Checkout Session (Manual fallback for when webhook is missed or delayed)
router.get('/checkout/session/:session_id', requireAuth, async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.params.session_id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (session.payment_status === 'paid' && session.metadata && session.metadata.logId) {
            const logId = session.metadata.logId;
            const userId = req.session.userId;
            
            // Mark log as paid if it isn't already
            db.run(`UPDATE logs SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status != 'paid'`, [logId, userId], function(err) {
                if (err) console.error('Failed to update log status manually:', err);
            });
            
            // Link customer ID if needed
            if (session.customer) {
                db.run(`UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL`, [session.customer, userId]);
            }
        }
        res.json({ payment_status: session.payment_status, status: session.status });
    } catch (error) {
        console.error('Error verifying session:', error);
        res.status(500).json({ error: 'Failed to verify session' });
    }
});

module.exports = router;
