import { NavigationContainer, LinkingOptions } from "@react-navigation/native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator } from "react-native";
import { AuthProvider } from "@/contexts/AuthContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { DesignProvider } from "@/design/DesignContext";
import { DesignNavigator, RootParamList } from "@/design/Navigator";
import { useDesignFonts } from "@/design/fonts";
import { config } from "@/lib/config";
import "@/i18n";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// Deep links for the password-reset flow. The emailed reset link opens
// ResetPassword with Firebase's `oobCode` (+ `mode`) query params — via the
// custom `istaseva://` scheme or the App/Universal Link on the web host.
const linking: LinkingOptions<RootParamList> = {
  prefixes: ["istaseva://", `${config.webUrl}`],
  config: {
    screens: {
      ResetPassword: "reset-password",
    },
  },
};

export default function App() {
  const fontsLoaded = useDesignFonts();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <LanguageProvider>
            <DesignProvider>
              <NavigationContainer linking={linking}>
                <StatusBar style="dark" />
                {fontsLoaded ? (
                  <DesignNavigator />
                ) : (
                  <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f4efe9" }}>
                    <ActivityIndicator color="#3a3247" />
                  </View>
                )}
              </NavigationContainer>
            </DesignProvider>
            </LanguageProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
