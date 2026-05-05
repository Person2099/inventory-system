import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "@/client/trpc";
import { useKiosk } from "@/contexts/kiosk-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2, CreditCard } from "lucide-react";

export default function KioskLanding() {
  const [studentId, setStudentId] = useState("");
  const { setSession } = useKiosk();
  const navigate = useNavigate();

  const lookup = trpc.kiosk.lookupStudent.useMutation({
    onSuccess: (data) => {
      if (!data.found) {
        toast.error(
          `No account found for ${data.studentInfo.name}. Please register first.`,
        );
        return;
      }
      setSession({
        student: {
          studentId: data.studentInfo.studentId,
          name: data.studentInfo.name,
          email: data.studentInfo.email,
          discordId: data.studentInfo.discordId,
        },
        user: data.user,
      });
      navigate("/kiosk/home");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = studentId.trim();
    if (!id) return;
    lookup.mutate({ studentId: id });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="flex justify-center mb-6">
            <div className="rounded-full bg-primary/10 p-6">
              <CreditCard className="w-12 h-12 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold">Kiosk Terminal</h1>
          <p className="text-muted-foreground text-sm">
            Tap your card or enter your student ID
          </p>
        </div>

        {/* TODO: replace input with NFC tap event listener when hardware available */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            autoFocus
            placeholder="Student ID"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            className="text-center text-lg h-14"
            disabled={lookup.isPending}
          />
          <Button
            type="submit"
            className="w-full h-12 text-base"
            disabled={!studentId.trim() || lookup.isPending}
          >
            {lookup.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Looking up...
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
