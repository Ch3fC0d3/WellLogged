require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

(async () => {
    try {
        console.log('Testing Stripe Connection...');
        const balance = await stripe.balance.retrieve();
        console.log('Stripe connection successful! Available balance:', balance.available[0].amount / 100, balance.available[0].currency);
        console.log('Your Stripe keys are correctly configured and working.');
        process.exit(0);
    } catch (err) {
        console.error('Stripe connection failed:', err.message);
        process.exit(1);
    }
})();
