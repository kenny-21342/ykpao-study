import type { Metadata } from "next";
import Script from "next/script";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import "./styles/editor.css";
import "./styles/chat.css";
import SessionProvider from "./components/SessionProvider";
import PWAInstall from "./components/PWAInstall";

/*
 * Geist is the font `create-next-app` ships with, which is exactly why the UI
 * read as generated. Plex is a deliberate choice: it has real tabular figures
 * for the marks and scores this app is full of, and Plex Mono handles the
 * pseudocode in Computer Science questions properly.
 *
 * Three weights, not six. Weight was doing the job that size should do —
 * having 700 available is what invites it back.
 */
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "YKPao Study - Intelligent Learning Platform",
  description: "An integrated smart education platform with past papers, AI tutoring, and collaborative notes",
  icons: {
    // No favicon.ico entry here on purpose. app/favicon.ico is a file
    // convention: the App Router serves it and emits its own <link> for it, so
    // listing it again produced two identical icon links in every page head.
    // It carries 16, 32 and 48 for a tab, a retina tab and a bookmark list.
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
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
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
              className: "!bg-surface !text-primary !border !border-line !rounded-lg !text-sm",
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
