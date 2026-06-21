import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Timur Gandon",
  description: "Интерактивная карта и энциклопедия мира СПЕЦИАЛЬНО ДЛЯ ДАЗОШИ",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
