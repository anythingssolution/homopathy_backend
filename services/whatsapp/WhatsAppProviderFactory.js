const { env } = require('../../config/env');
const MockWhatsAppProvider = require('./providers/MockWhatsAppProvider');
const MetaWhatsAppProvider = require('./providers/MetaWhatsAppProvider');

class WhatsAppProviderFactory {
    static mockProviderInstance = null;
    static metaProviderInstance = null;

    /**
     * Get the active WhatsApp provider instance
     */
    static getProvider() {
        const configuredProvider = String(process.env.WHATSAPP_PROVIDER || env.whatsapp?.provider || 'mock').trim().toLowerCase();

        // If explicitly set to 'meta' and credentials exist, use Meta provider
        if (configuredProvider === 'meta' && env.whatsapp?.accessToken && env.whatsapp?.phoneNumberId) {
            if (!this.metaProviderInstance) {
                this.metaProviderInstance = new MetaWhatsAppProvider();
            }
            return this.metaProviderInstance;
        }

        // Default to MockWhatsAppProvider for safe local development & simulations
        if (!this.mockProviderInstance) {
            this.mockProviderInstance = new MockWhatsAppProvider();
        }
        return this.mockProviderInstance;
    }

    static isMockMode() {
        return this.getProvider().getProviderName() === 'MOCK';
    }
}

module.exports = WhatsAppProviderFactory;
