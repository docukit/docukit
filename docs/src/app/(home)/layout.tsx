import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import { RootProvider } from "fumadocs-ui/provider/next";
import Footer from "@/components/Footer";

const options = {
  ...baseOptions,
  themeSwitch: {
    enabled: false,
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <RootProvider theme={{ ...baseOptions, forcedTheme: "dark" }}>
      <HomeLayout {...options}>
        {children}
        <Footer />
      </HomeLayout>
    </RootProvider>
  );
}
