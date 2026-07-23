import { createApp } from "vue";
import { createPinia } from "pinia";
import "./style.css";
import App from "./App.vue";
import LicenseView from "@/views/LicenseView.vue";
import { i18n } from "@/i18n";
import { router } from "@/router";
import { useSettingsStore } from "@/stores/settings";
import { useLicenseStore } from "@/stores/license";

const pinia = createPinia();

// Load persisted settings (language, currency, date format, logo) and the
// license status before the first paint. If the certification is invalid we
// mount only the activation lock screen — never the app shell — so no data
// screen or command is reachable. `allSettled` because when the license is
// invalid the backend leaves the DB unmanaged and `settings.load()` rejects.
const settings = useSettingsStore(pinia);
const license = useLicenseStore(pinia);

Promise.allSettled([settings.load(), license.load()]).finally(() => {
  const root = license.isValid ? App : LicenseView;
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.use(router);
  app.mount("#app");
});
