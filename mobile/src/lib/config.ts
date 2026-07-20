import Constants from "expo-constants";

type Extra = {
  apiBaseUrl: string;
  webUrl: string;
  firebaseApiKey: string;
  firebaseAuthDomain: string;
  firebaseProjectId: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config = {
  apiBaseUrl: extra.apiBaseUrl || "http://localhost:3000",
  webUrl: extra.webUrl || "http://localhost:8080",
  firebase: {
    apiKey: extra.firebaseApiKey || "",
    authDomain: extra.firebaseAuthDomain || "",
    projectId: extra.firebaseProjectId || "",
  },
};
