"use client";
import { useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
} from "ag-grid-community";
ModuleRegistry.registerModules([AllCommunityModule]);
const theme = themeQuartz.withParams({
  browserColorScheme: "dark",
  accentColor: "#c7ff55",
  backgroundColor: "#141823",
  foregroundColor: "#e9edf6",
  headerBackgroundColor: "#1c2230",
  headerTextColor: "#aebbd0",
  borderColor: "#303849",
  rowHoverColor: "#242d38",
  fontSize: 12,
  spacing: 6,
});
export default function Grid<T extends object>({
  name,
  rows,
  columns,
}: {
  name: string;
  rows: T[];
  columns: ColDef<T>[];
}) {
  const ref = useRef<AgGridReact<T>>(null);
  const [search, setSearch] = useState("");
  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <input
          aria-label={`Search ${name}`}
          placeholder={`Search ${name}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span>{rows.length} records</span>
        <button
          onClick={() =>
            ref.current?.api.exportDataAsCsv({
              fileName: `${name}.csv`,
              processCellCallback: (p) => {
                const v = String(p.value ?? "");
                return /^[=+@\-\t\r]/.test(v) ? `'${v}` : v;
              },
            })
          }
        >
          Export CSV ↗
        </button>
      </div>
      <div style={{ height: 360 }}>
        <AgGridReact<T>
          ref={ref}
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{
            flex: 1,
            minWidth: 150,
            filter: true,
            floatingFilter: true,
            sortable: true,
            resizable: true,
            enableCellChangeFlash: true,
          }}
          quickFilterText={search}
          animateRows
          pagination
          paginationPageSize={10}
          paginationPageSizeSelector={[10, 25, 50]}
          rowHeight={50}
        />
      </div>
      <div className="grid-credit">POWERED BY AG GRID COMMUNITY</div>
    </div>
  );
}
