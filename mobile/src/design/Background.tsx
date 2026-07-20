// design/Background.tsx — warm ambient screen backdrop approximating the prototype's
// radial saffron/blue tints over a near-white surface.
import React from "react";
import { View, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

export function Background({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.root}>
      {/* base wash */}
      <LinearGradient
        colors={["#f4efe9", "#f6f5f3", "#eef0f3"]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* top-right saffron glow */}
      <LinearGradient
        colors={["rgba(189,135,82,0.18)", "transparent"]}
        start={{ x: 0.9, y: 0 }}
        end={{ x: 0.4, y: 0.55 }}
        style={StyleSheet.absoluteFill}
      />
      {/* left blue glow */}
      <LinearGradient
        colors={["rgba(97,122,146,0.14)", "transparent"]}
        start={{ x: 0, y: 0.1 }}
        end={{ x: 0.55, y: 0.6 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f4efe9" },
});
