import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ModelProvider } from "@/components/model-provider";
import { Nav } from "@/components/nav";
import { StorageNotice } from "@/components/storage-notice";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Human Systems Lens",
  description:
    "Structural analysis of a system: slow variables, feedback loops, buffers and leverage.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <ModelProvider>
          <div className="flex min-h-screen flex-col">
            <Nav />
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8 md:py-10">
              <StorageNotice />
              {children}
            </main>
          </div>
        </ModelProvider>
      </body>
    </html>
  );
}
