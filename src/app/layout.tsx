import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { AppShell } from "./_components/app-shell";
import { ToastProvider } from "./_components/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s — Sseclone",
    default: "Sseclone",
  },
  description: "Turn long videos into short vertical clips.",
};

// Runs before paint (and before React hydrates): applies the stored theme so
// there is no flash. Dark is the default; only a returning light-mode user
// diverges from the statically-rendered `dark` class, which suppressHydration
// on <html> covers.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("sseclone-theme");var d=document.documentElement;d.classList.remove("dark","light");d.classList.add(t==="light"?"light":"dark");}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ToastProvider>
          <AppShell />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
