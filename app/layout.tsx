import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import "./styles/editor.css";
import "./styles/chat.css";
import "./styles/darkmode.css";
import "./styles/readability.css";
import SessionProvider from "./components/SessionProvider";
import PWAInstall from "./components/PWAInstall";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "YKPao Study - Intelligent Learning Platform",
  description: "An integrated smart education platform with past papers, AI tutoring, and collaborative notes",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    // iOS ignores the manifest for the home-screen icon and reads this link
    // tag instead, so without it an installed app shows a screenshot thumbnail.
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground transition-colors" suppressHydrationWarning>
        {/* Theme flash prevention: runs before paint so dark-mode users don't
            see a white flash. `beforeInteractive` is Next.js's blessed strategy
            for scripts that must execute during SSR/hydration. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`(function() {
            const root = document.documentElement;
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            let theme = systemTheme;
            try {
              const savedTheme = localStorage.getItem('theme');
              if (savedTheme === 'dark' || savedTheme === 'light') {
                theme = savedTheme;
              }
            } catch {}
            root.classList.toggle('dark', theme === 'dark');
            root.dataset.theme = theme;
            root.style.colorScheme = theme;
          })();`}
        </Script>
        <SessionProvider>
          {children}
          <PWAInstall />
          <Toaster
            position="bottom-right"
            toastOptions={{
              className: "!bg-white !text-gray-900 dark:!bg-gray-900 dark:!text-gray-100 !border !border-gray-200 dark:!border-gray-700 !rounded-xl !text-sm",
              duration: 4500,
            }}
          />
        </SessionProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
