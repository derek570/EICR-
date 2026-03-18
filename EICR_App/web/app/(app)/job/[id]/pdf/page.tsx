"use client";

import { useState } from "react";
import { useJobContext } from "../layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FileText,
  Download,
  Loader2,
  WifiOff,
  FolderOpen,
  Mail,
  Send,
  CheckCircle,
  FileSpreadsheet,
  Table,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { api } from "@/lib/api-client";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function PDFPage() {
  const { job, user } = useJobContext();
  const [generating, setGenerating] = useState(false);
  const [exportingCSV, setExportingCSV] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);

  // Email form
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailClientName, setEmailClientName] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

  const handleGenerate = async () => {
    if (!user) { toast.error("Not logged in"); return; }
    if (isOffline) { toast.error("PDF generation requires an internet connection"); return; }

    setGenerating(true);
    try {
      const blob = await api.generatePdf(user.id, job.id);
      const suggestedName = `EICR_${job.address.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("PDF downloaded");
    } catch (error) {
      console.error("PDF generation failed:", error);
      toast.error("Failed to generate PDF");
    } finally {
      setGenerating(false);
    }
  };

  const handleSendEmail = async () => {
    if (!user) { toast.error("Not logged in"); return; }
    if (!emailTo || !isValidEmail(emailTo)) { toast.error("Please enter a valid email address"); return; }

    setSendingEmail(true);
    try {
      await api.sendEmail(user.id, job.id, emailTo, emailClientName || undefined);
      setEmailSent(true);
      toast.success(`Certificate sent to ${emailTo}`);
    } catch (error) {
      console.error("Email sending failed:", error);
      toast.error("Failed to send email");
    } finally {
      setSendingEmail(false);
    }
  };

  const handleExportCSV = async () => {
    if (!user) { toast.error("Not logged in"); return; }
    setExportingCSV(true);
    try {
      await api.exportCSV(user.id, job.id);
      toast.success("CSV downloaded");
    } catch (error) {
      console.error("CSV export failed:", error);
      toast.error("Failed to export CSV");
    } finally {
      setExportingCSV(false);
    }
  };

  const handleExportExcel = async () => {
    if (!user) { toast.error("Not logged in"); return; }
    setExportingExcel(true);
    try {
      await api.exportExcel(user.id, job.id);
      toast.success("Excel workbook downloaded");
    } catch (error) {
      console.error("Excel export failed:", error);
      toast.error("Failed to export Excel");
    } finally {
      setExportingExcel(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <h2 className="text-lg font-semibold">PDF Certificate</h2>

      {/* Generate PDF */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />Generate Certificate</CardTitle>
          <CardDescription>Generate the EICR/EIC certificate PDF for {job.address}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-gray-500">
            <p>Certificate will include:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>{job.circuits.length} circuits</li>
              <li>{job.observations.length} observations</li>
              <li>Board information and test results</li>
            </ul>
          </div>
          {isOffline && (
            <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-md">
              <WifiOff className="h-4 w-4" />
              <span>PDF generation requires an internet connection</span>
            </div>
          )}
          <Button onClick={handleGenerate} disabled={generating || isOffline} className="w-full">
            {generating ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...</>
            ) : (
              <><Download className="h-4 w-4 mr-2" />Generate PDF</>
            )}
          </Button>
          {generating && (
            <p className="text-sm text-gray-500 text-center">Usually takes 5-10 seconds</p>
          )}
        </CardContent>
      </Card>

      {/* Email */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" />Send by Email</CardTitle>
          <CardDescription>Email the certificate PDF directly to your client</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!showEmailForm ? (
            <Button onClick={() => setShowEmailForm(true)} disabled={isOffline} variant="outline" className="w-full">
              <Mail className="h-4 w-4 mr-2" />Send by Email
            </Button>
          ) : emailSent ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 p-3 rounded-md">
                <CheckCircle className="h-4 w-4" />
                <span>Certificate sent to {emailTo}</span>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => { setEmailSent(false); setEmailTo(""); setEmailClientName(""); }} variant="outline" className="flex-1">
                  Send to Another
                </Button>
                <Button onClick={() => { setShowEmailForm(false); setEmailSent(false); setEmailTo(""); }} variant="ghost">
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Recipient Email</label>
                <Input type="email" placeholder="client@example.com" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} disabled={sendingEmail} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Client Name <span className="text-xs text-gray-500">(optional)</span></label>
                <Input placeholder="e.g. Mrs Smith" value={emailClientName} onChange={(e) => setEmailClientName(e.target.value)} disabled={sendingEmail} />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSendEmail} disabled={sendingEmail || !emailTo || !isValidEmail(emailTo)} className="flex-1">
                  {sendingEmail ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending...</> : <><Send className="h-4 w-4 mr-2" />Send Certificate</>}
                </Button>
                <Button onClick={() => { setShowEmailForm(false); setEmailTo(""); }} variant="ghost" disabled={sendingEmail}>Cancel</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Export Data */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" />Export Data</CardTitle>
          <CardDescription>Download job data as CSV or Excel</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button onClick={handleExportCSV} disabled={exportingCSV || isOffline} variant="outline" className="flex-1">
              {exportingCSV ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Exporting...</> : <><Table className="h-4 w-4 mr-2" />Export CSV</>}
            </Button>
            <Button onClick={handleExportExcel} disabled={exportingExcel || isOffline} variant="outline" className="flex-1">
              {exportingExcel ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Exporting...</> : <><FileSpreadsheet className="h-4 w-4 mr-2" />Export Excel</>}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
