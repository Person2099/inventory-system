import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useKiosk } from "@/contexts/kiosk-context";
import { trpc } from "@/client/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  ArrowLeft,
  Camera,
  Loader2,
  PackagePlus,
  Trash2,
  X,
} from "lucide-react";
import { BrowserMultiFormatReader } from "@zxing/library";

interface ScannedItem {
  id: string;
  name: string;
  serial: string;
}

export default function KioskCheckout() {
  const { session } = useKiosk();
  const navigate = useNavigate();
  const [items, setItems] = useState<ScannedItem[]>([]);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const lastScanRef = useRef<{ id: string; ts: number } | null>(null);

  useEffect(() => {
    if (!session) navigate("/kiosk", { replace: true });
    return () => stopCamera();
  }, [session, navigate]);

  const getItem = trpc.kiosk.getItemByQR.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const checkout = trpc.kiosk.checkoutItems.useMutation({
    onSuccess: (data) => {
      if (data.ok) {
        toast.success("Items checked out successfully");
        navigate("/kiosk/home");
      } else {
        toast.error(
          typeof data.failures === "string"
            ? data.failures
            : "Some items could not be checked out",
        );
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const stopCamera = () => {
    if (readerRef.current) {
      readerRef.current.reset();
      readerRef.current = null;
    }
    setScanning(false);
  };

  const startCamera = useCallback(async () => {
    try {
      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;
      const devices = await reader.listVideoInputDevices();
      if (!devices.length) throw new Error("No camera found");
      setScanning(true);
      await reader.decodeFromVideoDevice(
        devices[0].deviceId,
        videoRef.current,
        async (result, err) => {
          if (!result) return;
          if (
            err &&
            err.name !== "NotFoundException" &&
            err.name !== "NotFoundException2"
          )
            return;

          const qrData = result.getText();
          const segments = qrData.trim().split("/");
          const qrIndex = segments.indexOf("qr");
          const itemId =
            qrIndex !== -1
              ? (segments[qrIndex + 1] ?? "")
              : (segments[segments.length - 1] ?? "");

          if (!itemId) return;

          // Debounce: ignore same item within 3 seconds
          const now = Date.now();
          if (
            lastScanRef.current?.id === itemId &&
            now - lastScanRef.current.ts < 3000
          )
            return;
          lastScanRef.current = { id: itemId, ts: now };

          if (items.some((i) => i.id === itemId)) {
            toast.info("Item already in list");
            return;
          }

          try {
            const item = await getItem.mutateAsync({ qrData });
            if (!item) return;

            const latestRecord = item.ItemRecords[0];
            if (latestRecord?.loaned) {
              toast.error(`${item.name} is already on loan`);
              return;
            }

            setItems((prev) => [
              ...prev,
              { id: item.id, name: item.name, serial: item.serial },
            ]);
            toast.success(`Added: ${item.name}`);
          } catch {
            // error handled by mutation
          }
        },
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start camera",
      );
      setScanning(false);
    }
  }, [items, getItem]);

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((i) => i.id !== id));

  const handleConfirm = () => {
    if (!session || items.length === 0) return;
    checkout.mutate({
      studentId: session.student.studentId,
      itemIds: items.map((i) => i.id),
    });
  };

  if (!session) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b px-8 py-4 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            stopCamera();
            navigate("/kiosk/home");
          }}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2">
          <PackagePlus className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold">Check Out Items</h1>
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row gap-6 p-8">
        {/* Camera panel */}
        <div className="md:w-1/2 space-y-3">
          <p className="text-sm text-muted-foreground">
            Scan item QR codes to add them to your cart
          </p>
          <div className="aspect-square w-full max-w-sm mx-auto bg-black rounded-lg overflow-hidden relative">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ display: scanning ? "block" : "none" }}
            />
            {!scanning && (
              <div className="w-full h-full flex items-center justify-center text-white">
                <div className="text-center space-y-3">
                  <Camera className="w-12 h-12 mx-auto opacity-50" />
                  <p className="text-sm">Camera not active</p>
                </div>
              </div>
            )}
            {scanning && (
              <div className="absolute inset-4 border-2 border-primary rounded-lg pointer-events-none">
                <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br" />
              </div>
            )}
          </div>
          {!scanning ? (
            <Button
              onClick={startCamera}
              className="w-full max-w-sm mx-auto flex"
            >
              <Camera className="w-4 h-4 mr-2" />
              Start Scanning
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={stopCamera}
              className="w-full max-w-sm mx-auto flex"
            >
              <X className="w-4 h-4 mr-2" />
              Stop Camera
            </Button>
          )}
        </div>

        {/* Item list panel */}
        <div className="md:w-1/2 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">
              Scanned Items
              {items.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {items.length}
                </Badge>
              )}
            </h2>
          </div>

          {items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center border border-dashed rounded-lg p-8">
              <p className="text-sm text-muted-foreground text-center">
                No items scanned yet.
                <br />
                Start the camera and scan a QR code.
              </p>
            </div>
          ) : (
            <div className="flex-1 space-y-2 overflow-y-auto">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg border px-4 py-3"
                >
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.serial}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeItem(item.id)}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <Button
              className="h-12 text-base"
              disabled={checkout.isPending}
              onClick={handleConfirm}
            >
              {checkout.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                `Check Out ${items.length} Item${items.length !== 1 ? "s" : ""}`
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
