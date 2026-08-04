'use strict';

module.exports = {
  async getCredentialStatus({ homey }) {
    return homey.app.getCredentialStatus();
  },

  async saveCredentials({ homey, body }) {
    return homey.app.saveGlobalCredentials(body || {});
  },

  async clearCredentials({ homey }) {
    return homey.app.clearGlobalCredentials();
  },

  async adoptLegacyCredentials({ homey }) {
    return homey.app.adoptMatchingLegacyDevices();
  },
};
