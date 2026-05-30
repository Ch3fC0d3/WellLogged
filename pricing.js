/**
 * Shared pricing logic. Mirrors the live estimate shown on the public quote page
 * (public/quote.html updateEstimate) and the admin "Auto" button so that the
 * amount_due stored on a log always matches what the customer was quoted.
 *
 * Rate tiers:
 *   - 1-4 logs:  $0.69 / curve / 100 ft, with a $29.99 minimum
 *   - 5-20 logs: $0.49 / curve / 100 ft
 *   - 21+ logs:  custom pricing (returns null -> admin sets manually)
 *
 * @param {Object} specs
 * @param {number|string} specs.numLogs
 * @param {number|string} specs.curves
 * @param {number|string} specs.footage - feet per log
 * @returns {number|null} amount due in cents, or null when custom pricing is required
 */
function calculateAmountDueCents({ numLogs, curves, footage }) {
    numLogs = Math.max(1, parseInt(numLogs, 10) || 1);
    curves = Math.max(1, parseInt(curves, 10) || 1);
    footage = Math.max(0, parseInt(footage, 10) || 0);

    // Large archives need a custom quote handled by an admin.
    if (numLogs > 20) return null;

    const totalCurveFeet = numLogs * curves * footage;
    const billableUnits = Math.ceil(totalCurveFeet / 100); // round up to next 100 ft
    const rate = numLogs >= 5 ? 0.49 : 0.69;
    let totalDollars = billableUnits * rate;

    // $29.99 minimum for single / small batches (1-4 logs).
    if (numLogs < 5 && totalDollars < 29.99) totalDollars = 29.99;

    return Math.round(totalDollars * 100);
}

module.exports = { calculateAmountDueCents };
