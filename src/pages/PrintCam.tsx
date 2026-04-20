import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "@/client/trpc";
import { Button } from "@/components/ui/button";

interface PrinterCam {
  id: string;
  name: string;
  type: string;
  ipAddress: string;
  webcamUrl: string | null;
}

const buildProxyCameraUrl = (printerId: string, snapshotTick: number): string =>
  `/api/webcam/${encodeURIComponent(printerId)}?mode=snapshot&_t=${snapshotTick}`;

function WebcamTile({
  printer,
  globalTick,
}: {
  printer: PrinterCam;
  globalTick: number;
}) {
  const [localTick, setLocalTick] = useState(0);
  const tick = globalTick + localTick;

  const cameraUrl = useMemo(
    () => buildProxyCameraUrl(printer.id, tick),
    [printer.id, tick],
  );

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="overflow-hidden rounded-lg border bg-black aspect-video w-full cursor-pointer"
        onClick={() => setLocalTick((n) => n + 1)}
      >
        <img
          src={cameraUrl}
          alt={`${printer.name} camera`}
          className="h-full w-full object-contain"
        />
      </div>
      <p className="text-sm font-medium text-center">{printer.name}</p>
      <p className="text-xs text-muted-foreground text-center">
        {printer.type} • {printer.ipAddress}
      </p>
    </div>
  );
}

export default function PrintCam() {
  const printersQuery = trpc.print.getPrinterMonitoringOptions.useQuery();
  const [globalTick, setGlobalTick] = useState(0);

  const webcamPrinters = (printersQuery.data ?? []).filter((p) => p.webcamUrl);

  const gridClass =
    webcamPrinters.length === 1
      ? "grid gap-6 max-w-3xl mx-auto w-full"
      : webcamPrinters.length === 2
        ? "grid gap-6 md:grid-cols-2"
        : "grid gap-6 md:grid-cols-2 xl:grid-cols-3";

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">All Webcams</h1>
          <p className="text-muted-foreground">
            Snapshot view of all configured printer webcams.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setGlobalTick((n) => n + 1)}
          >
            Refresh All
          </Button>
          <Button asChild variant="secondary">
            <Link to="/print-monitor">Back to Monitoring</Link>
          </Button>
        </div>
      </div>

      {printersQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading webcams…</p>
      ) : webcamPrinters.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No printers have a webcam URL configured.
        </p>
      ) : (
        <div className={gridClass}>
          {webcamPrinters.map((printer) => (
            <WebcamTile
              key={printer.id}
              printer={printer}
              globalTick={globalTick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
