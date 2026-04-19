export default defineEventHandler(async () => {
  const insecure = WG_ENV.INSECURE;
  const isAwg = WG_ENV.WG_EXECUTABLE === 'awg';
  const wgInterface = await Database.interfaces.get();

  return {
    currentRelease: RELEASE,
    latestRelease: null,
    updateAvailable: false,
    insecure,
    isAwg,
    firewallEnabled: wgInterface.firewallEnabled,
  };
});
