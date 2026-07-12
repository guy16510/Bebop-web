globalThis.addEventListener('bebop-autonomy-status', (event) => {
  const pads = event.detail?.navigation?.map?.landingPads ?? [];
  globalThis.dispatchEvent(new CustomEvent('bebop-navigation-pads', { detail: pads }));
});
