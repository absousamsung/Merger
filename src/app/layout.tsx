import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "لوحة إدارة مولّد الوسائط — MCP",
  description: "إدارة مفاتيح API، متابعة مهام توليد الصور والفيديو، وإعدادات ربط MCP",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
