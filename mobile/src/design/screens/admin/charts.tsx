// Lightweight chart wrappers (react-native-gifted-charts) for the admin tabs.
import React from "react";
import { View, Dimensions } from "react-native";
import { LineChart, BarChart } from "react-native-gifted-charts";
import { T } from "../../theme";

// gifted-charts renders the y-axis label gutter OUTSIDE the `width` prop, so
// the drawing area must be narrowed by it or the plot bleeds past the card's
// right edge.
const Y_LABEL_W = 32;
// Width available inside an admin card: screen − screen padding (16*2) −
// card padding (14*2) − y-axis label gutter.
const chartWidth = () => Dimensions.get("window").width - 60 - Y_LABEL_W;

/** Single- to triple-series area/line trend (sparkline style).
 *  `dashed2` renders the second series as a dashed line with no area fill —
 *  the "previous period" overlay style shared with the web dashboard.
 *  `prevValues` is a third series that is ALWAYS dashed + unfilled, for when
 *  both regular series are in use (e.g. bookings + cancelled + previous). */
export function TrendChart({ values, values2, prevValues, color = T.aubergine, color2, prevColor = T.muted, dashed2, height = 150 }: {
  values: number[];
  values2?: number[];
  prevValues?: number[];
  color?: string;
  color2?: string;
  prevColor?: string;
  dashed2?: boolean;
  height?: number;
}) {
  const width = chartWidth();
  const n = Math.max(values.length, 1);
  // Points span initialSpacing + (n−1)·spacing + endSpacing — keep that sum
  // inside `width` so the last point (and the curve's overshoot) stays in the
  // card instead of running off the right edge.
  const spacing = Math.max(2, (width - 26) / Math.max(n - 1, 1));
  return (
    <View style={{ overflow: "hidden" }}>
      <LineChart
        data={values.map((v) => ({ value: v }))}
        data2={values2 ? values2.map((v) => ({ value: v })) : undefined}
        data3={prevValues ? prevValues.map((v) => ({ value: v })) : undefined}
        color3={prevColor}
        strokeDashArray3={[5, 5]}
        startOpacity3={0}
        endOpacity3={0}
        width={width}
        height={height}
        spacing={spacing}
        initialSpacing={10}
        endSpacing={16}
        yAxisLabelWidth={Y_LABEL_W}
        thickness={2}
        color={color}
        color2={color2}
        hideDataPoints
        curved
        areaChart
        startFillColor={color}
        startOpacity={0.18}
        endOpacity={0.02}
        startFillColor2={color2}
        startOpacity2={dashed2 ? 0 : 0.12}
        endOpacity2={dashed2 ? 0 : 0.02}
        strokeDashArray2={dashed2 ? [5, 5] : undefined}
        yAxisThickness={0}
        xAxisThickness={0}
        hideRules
        noOfSections={3}
        yAxisTextStyle={{ fontSize: 9, color: T.muted }}
      />
    </View>
  );
}

/** Two-series grouped bars: each group renders a touching pair of bars
 *  (e.g. bookings vs cancelled per day) separated from the next group.
 *  Pair grouping is gifted-charts' interleaved-data recipe — the first bar of
 *  a pair carries the label and a tight `spacing` to its partner. */
export function PairedBarsChart({ groups, colors, height = 150 }: {
  groups: Array<{ label: string; values: [number, number] }>;
  colors: [string, string];
  height?: number;
}) {
  const width = chartWidth();
  const n = Math.max(groups.length, 1);
  // Per group: two bars + 2px intra-pair gap + ~0.9-bar inter-group gap.
  const barWidth = Math.max(5, Math.min(22, Math.floor((width - 20) / (n * 2.9))));
  const spacing = Math.max(6, Math.floor(barWidth * 0.9));
  const data = groups.flatMap((g) => [
    {
      value: g.values[0],
      label: g.label,
      labelWidth: barWidth * 2 + 2,
      labelTextStyle: { fontSize: 8.5, color: T.muted },
      spacing: 2,
      frontColor: colors[0],
    },
    { value: g.values[1], frontColor: colors[1] },
  ]);
  return (
    <View style={{ overflow: "hidden" }}>
      <BarChart
        data={data}
        width={width}
        height={height}
        barWidth={barWidth}
        spacing={spacing}
        initialSpacing={6}
        yAxisLabelWidth={Y_LABEL_W}
        roundedTop
        barBorderRadius={3}
        yAxisThickness={0}
        xAxisThickness={0}
        hideRules
        noOfSections={3}
        yAxisTextStyle={{ fontSize: 9, color: T.muted }}
      />
    </View>
  );
}

/** Category / grouped bar chart. */
export function BarsChart({ bars, height = 170 }: {
  bars: Array<{ label: string; value: number; color?: string }>;
  height?: number;
}) {
  const width = chartWidth();
  const count = Math.max(bars.length, 1);
  const barWidth = Math.max(16, Math.min(40, Math.floor((width - 40) / (count * 1.8))));
  return (
    <BarChart
      data={bars.map((b) => ({ value: b.value, label: b.label, frontColor: b.color ?? T.aubergine }))}
      width={width}
      height={height}
      barWidth={barWidth}
      spacing={barWidth * 0.9}
      initialSpacing={14}
      yAxisLabelWidth={Y_LABEL_W}
      roundedTop
      barBorderRadius={5}
      yAxisThickness={0}
      xAxisThickness={0}
      hideRules
      noOfSections={3}
      xAxisLabelTextStyle={{ fontSize: 9, color: T.muted }}
      yAxisTextStyle={{ fontSize: 9, color: T.muted }}
    />
  );
}
