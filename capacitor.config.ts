import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.slphospitality.canteenhub",
  appName: "SLP Canteen Hub",
  webDir: "dist",
  // The app is a shell over the live site: every web deploy updates the
  // app instantly, no APK rebuild. (Supabase needs internet anyway.)
  server: {
    url: "https://slp-canteen-hub-fixed.vercel.app",
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#FFFFFF",
      showSpinner: false,
    },
  },
};

export default config;
