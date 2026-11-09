"use client";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "Inter, system-ui, sans-serif",
  headerFontWeight: 600,
  headerBackgroundColor: "#f8fafc",
  borderColor: "#e2e8f0",
  rowHoverColor: "#f1f5f9",
  accentColor: "#059669",
  spacing: 6,
  wrapperBorderRadius: 10,
});

export function Grid<T>({ rows, cols, height }: { rows: T[]; cols: ColDef<T>[]; height?: number }) {
  return (
    <div style={height ? { height } : undefined}>
      <AgGridReact<T>
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        domLayout={height ? "normal" : "autoHeight"}
        defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }}
        autoSizeStrategy={{ type: "fitGridWidth" }}
        suppressCellFocus
      />
    </div>
  );
}
