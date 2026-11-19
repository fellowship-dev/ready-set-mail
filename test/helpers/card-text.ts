/**
 * The test card's last four digits as a token of its own. A bare `/4242/` also matches a random hex workspace or order id that happens to contain
 * those digits (about one run in a thousand), so a test that scans ids must not use it. A card shown anywhere is a standalone `4242` (`last4: 4242`,
 * "ending in 4242", "•••• 4242"); an id has letters, digits, `_` or `-` on both sides of any such run.
 */
export const CARD_LAST4 = /(?<![\w-])4242(?![\w-])/;
/** The test card's last four digits as a standalone token, or its brand. */
export const CARD_DETAILS = /(?<![\w-])4242(?![\w-])|visa/i;
