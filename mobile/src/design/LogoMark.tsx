// design/LogoMark.tsx — IstaSeva logo (house-in-pin) ported from onboarding.jsx.
import React from "react";
import Svg, { Path, Defs, LinearGradient as SvgGrad, Stop } from "react-native-svg";

export function LogoMark({ size = 48 }: { size?: number }) {
  return (
    <Svg viewBox="0 0 64 64" width={size} height={size}>
      <Defs>
        <SvgGrad id="obLogo" x1="12" y1="8" x2="52" y2="58" gradientUnits="userSpaceOnUse">
          <Stop stopColor="#f7e8d7" />
          <Stop offset="0.6" stopColor="#e7c39c" />
          <Stop offset="1" stopColor="#bd8752" />
        </SvgGrad>
      </Defs>
      <Path d="M32 5c-10.5 0-19 8.1-19 18.1 0 13.4 15.1 29.6 18.2 32.7a1.1 1.1 0 0 0 1.6 0C35.9 52.7 51 36.5 51 23.1 51 13.1 42.5 5 32 5Z" fill="url(#obLogo)" />
      <Path d="M21.5 27.8 32 18.9l10.5 8.9v12.4a2.2 2.2 0 0 1-2.2 2.2H23.7a2.2 2.2 0 0 1-2.2-2.2V27.8Z" fill="rgba(40,34,52,0.92)" />
      <Path d="M28.3 42.4V32.1a3.7 3.7 0 0 1 7.4 0v10.3" fill="none" stroke="#f7e8d7" strokeWidth="3.1" strokeLinecap="round" />
    </Svg>
  );
}
