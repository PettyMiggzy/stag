// Extra behaviour when STAGR runs inside the iPhone or Android app (Capacitor). On the web nothing here does anything.
import { del, post } from './core.js';
const Cap = window.Capacitor, plug = n => Cap?.Plugins?.[n];
export const isNative = !!Cap?.isNativePlatform?.();
const TOKEN_KEY = 'stagr_push_token', ASKED_KEY = 'stagr_push_asked';

export async function initNative() {
  if (!isNative) return;
  const Haptics = plug('Haptics'), Push = plug('PushNotifications'), App = plug('App');
  // a light tap on primary buttons, like a native app
  if (Haptics) document.addEventListener('click', e => { if (e.target.closest?.('.btn.main,.tabbar a')) Haptics.impact({ style: 'LIGHT' }).catch(() => {}); }, { passive: true });
  // Android back button: go back, or leave the app from the home screen
  App?.addListener?.('backButton', ({ canGoBack }) => { if (canGoBack && location.hash && location.hash !== '#/') history.back(); else App.exitApp?.(); });
  if (!Push) return;
  Push.addListener('registration', async t => { try { localStorage.setItem(TOKEN_KEY, t.value); await post('/devices', { platform: Cap.getPlatform(), token: t.value }); } catch {} });
  Push.addListener('pushNotificationActionPerformed', a => { const path = a?.notification?.data?.path; if (typeof path === 'string' && path.startsWith('/')) location.hash = '#' + path; });
  try {
    let p = await Push.checkPermissions();
    if (p.receive === 'prompt' && !localStorage.getItem(ASKED_KEY)) { localStorage.setItem(ASKED_KEY, '1'); p = await Push.requestPermissions(); }
    if (p.receive === 'granted') await Push.register();
  } catch {}
}

// Called when the person signs out so this phone stops getting their notifications.
export async function forgetDevice() {
  const t = localStorage.getItem(TOKEN_KEY); if (!t) return;
  try { await del('/devices', { token: t }); } catch {}
  localStorage.removeItem(TOKEN_KEY);
}
