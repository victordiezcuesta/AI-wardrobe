import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "AI Wardrobe", template: "%s · AI Wardrobe" },
  description: "Tu estilista personal con inteligencia artificial.",
};
export const viewport: Viewport = { themeColor: "#f6f3ee", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
