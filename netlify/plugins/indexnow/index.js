// netlify/plugins/indexnow — tell IndexNow (Bing) about the published URLs once the deploy is LIVE.
//
// onSuccess, not the build command: a ping that lands before the deploy publishes the key file gets
// the key refused (scripts/indexnow-ping.mjs explains). Production-only and never fails anything —
// both decided inside pingIndexNow.
module.exports = {
  async onSuccess() {
    const { pingIndexNow } = await import('../../../scripts/indexnow-ping.mjs');
    await pingIndexNow();
  },
};
