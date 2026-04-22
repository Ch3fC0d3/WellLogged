const express = require('express');
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...' ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const db = require('../db');
const router = express.Router();

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            if (session.metadata && session.metadata.logId) {
                handleLogCheckoutSuccess(session);
            }
            break;
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
            const subscription = event.data.object;
            handleSubscriptionChange(subscription);
            break;
        case 'customer.subscription.deleted':
            const subDeleted = event.data.object;
            handleSubscriptionDeleted(subDeleted);
            break;
        case 'invoice.payment_succeeded':
            const invoice = event.data.object;
            handleInvoiceSuccess(invoice);
            break;
        case 'invoice.payment_failed':
            const invoiceFailed = event.data.object;
            handleInvoiceFailed(invoiceFailed);
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
});

function getUserByStripeCustomerId(customerId, callback) {
    db.get(`SELECT id FROM users WHERE stripe_customer_id = ?`, [customerId], (err, user) => {
        if (user) callback(user.id);
    });
}

function handleLogCheckoutSuccess(session) {
    const logId = session.metadata.logId;
    const userId = session.metadata.userId;
    const customerId = session.customer;

    // Update log status to paid
    db.run(`UPDATE logs SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [logId, userId], (err) => {
        if (err) console.error('Failed to update log to paid:', err);
        else console.log(`Log ${logId} marked as paid.`);
    });

    // Make sure user has the customer ID saved
    if (customerId) {
        db.run(`UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL`, [customerId, userId]);
    }
}

function handleSubscriptionChange(sub) {
    getUserByStripeCustomerId(sub.customer, (userId) => {
        db.run(`INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end) 
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(stripe_subscription_id) DO UPDATE SET 
                    status=excluded.status, 
                    current_period_end=excluded.current_period_end, 
                    cancel_at_period_end=excluded.cancel_at_period_end,
                    updated_at=CURRENT_TIMESTAMP`,
            [userId, sub.id, sub.status, sub.current_period_end, sub.cancel_at_period_end ? 1 : 0]);
    });
}

function handleSubscriptionDeleted(sub) {
    getUserByStripeCustomerId(sub.customer, (userId) => {
        db.run(`UPDATE subscriptions SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = ?`, [sub.id]);
    });
}

function handleInvoiceSuccess(invoice) {
    getUserByStripeCustomerId(invoice.customer, (userId) => {
        db.run(`INSERT INTO invoices (user_id, stripe_invoice_id, amount, currency, status, hosted_invoice_url, invoice_pdf_url)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(stripe_invoice_id) DO UPDATE SET status=excluded.status`,
            [userId, invoice.id, invoice.amount_due, invoice.currency, invoice.status, invoice.hosted_invoice_url, invoice.invoice_pdf]);
    });
}

function handleInvoiceFailed(invoice) {
    getUserByStripeCustomerId(invoice.customer, (userId) => {
        db.run(`UPDATE invoices SET status = 'failed' WHERE stripe_invoice_id = ?`, [invoice.id]);
    });
}

module.exports = router;
