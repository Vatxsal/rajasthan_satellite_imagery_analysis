/** Visible header wordmark text (must stay a substring of WORDMARK_LABEL). */
export const WORDMARK_TEXT = "Rajasthan Imagery Explorer";

/**
 * Accessible name of the top-left wordmark link: visible text plus ", home"
 * so screen readers announce it as the home link, while Lighthouse's
 * label-content-name-mismatch check still passes (accname contains the text).
 */
export const WORDMARK_LABEL = "Rajasthan Imagery Explorer, home";
