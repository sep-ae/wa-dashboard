/**
 * Normalizes any Indonesian / International phone number input
 * Examples:
 * - '0812-3456-7890' -> '6281234567890'
 * - '+62 812 3456 7890' -> '6281234567890'
 * - '81234567890' -> '6281234567890'
 * - '6281234567890@s.whatsapp.net' -> '6281234567890'
 */
function normalizePhoneNumber(input) {
    if (!input) return '';

    // Convert to string and remove all non-numeric characters
    let cleaned = input.toString().replace(/@s\.whatsapp\.net/g, '').replace(/[^0-9]/g, '');

    // If starts with '08', change leading '0' to '62' -> '628...'
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.slice(1);
    }
    // If starts with '8' (e.g. 81234567890), prepend '62'
    else if (cleaned.startsWith('8')) {
        cleaned = '62' + cleaned;
    }

    return cleaned;
}

/**
 * Returns formatted WhatsApp JID
 * Example: '081234567890' -> '6281234567890@s.whatsapp.net'
 */
function toWhatsAppJid(input) {
    const cleanNumber = normalizePhoneNumber(input);
    if (!cleanNumber) return '';
    return `${cleanNumber}@s.whatsapp.net`;
}

module.exports = {
    normalizePhoneNumber,
    toWhatsAppJid
};
