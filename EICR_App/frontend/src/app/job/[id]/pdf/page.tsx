"use client";

import { useJob } from "../layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Download, Loader2, WifiOff, FolderOpen, Mail, Send, CheckCircle, XCircle, FileSpreadsheet, Table, MessageCircle, Phone } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

// Type for the File System Access API (not available in all browsers)
interface FileSystemWritableFileStream extends WritableStream {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface ShowSaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

// Extend Window type for showSaveFilePicker
declare global {
  interface Window {
    showSaveFilePicker?: (options?: ShowSaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function PDFPage() {
  const { job, user } = useJob();
  const [generating, setGenerating] = useState(false);

  const [exportingCSV, setExportingCSV] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);

  // Email form state
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailClientName, setEmailClientName] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  // WhatsApp form state
  const [showWhatsAppForm, setShowWhatsAppForm] = useState(false);
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [whatsAppSent, setWhatsAppSent] = useState(false);
  const [whatsAppConfigured, setWhatsAppConfigured] = useState<boolean | null>(null);

  // Check if File System Access API is supported
  const supportsFilePicker = typeof window !== "undefined" && "showSaveFilePicker" in window;

  const handleGenerate = async (useFilePicker = false) => {
    if (!user) {
      toast.error("Not logged in");
      return;
    }

    if (!navigator.onLine) {
      toast.error("PDF generation requires an internet connection");
      return;
    }

    setGenerating(true);
    try {
      const blob = await api.generatePdf(user.id, job.id);
      const suggestedName = `EICR_${job.address.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;

      // Try File System Access API if requested and supported
      if (useFilePicker && supportsFilePicker && window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName,
            types: [
              {
                description: "PDF Document",
                accept: { "application/pdf": [".pdf"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          toast.success("PDF saved successfully");
          return;
        } catch (err) {
          // User cancelled or API not available, fall through to regular download
          if ((err as Error).name !== "AbortError") {
            console.error("File picker error:", err);
          } else {
            // User cancelled
            return;
          }
        }
      }

      // Fallback: Create download link (browser default download location)
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
    if (!user) {
      toast.error("Not logged in");
      return;
    }

    if (!emailTo || !isValidEmail(emailTo)) {
      toast.error("Please enter a valid email address");
      return;
    }

    setSendingEmail(true);
    try {
      await api.sendEmail(user.id, job.id, emailTo, emailClientName || undefined);
      setEmailSent(true);
      toast.success(`Certificate sent to ${emailTo}`);
    } catch (error) {
      console.error("Email sending failed:", error);
      const message = error instanceof Error ? error.message : "Failed to send email";
      toast.error(message);
    } finally {
      setSendingEmail(false);
    }
  };

  const handleToggleEmailForm = () => {
    setShowEmailForm(!showEmailForm);
    // Reset state when closing
    if (showEmailForm) {
      setEmailTo("");
      setEmailClientName("");
      setEmailSent(false);
    }
  };

  // Check WhatsApp configuration on mount
  useEffect(() => {
    api.getWhatsAppStatus()
      .then((status) => setWhatsAppConfigured(status.configured))
      .catch(() => setWhatsAppConfigured(false));
  }, []);

  const handleSendWhatsApp = async () => {
    if (!user) {
      toast.error("Not logged in");
      return;
    }

    if (!whatsAppPhone) {
      toast.error("Please enter a phone number");
      return;
    }

    setSendingWhatsApp(true);
    try {
      await api.sendWhatsApp(user.id, job.id, whatsAppPhone);
      setWhatsAppSent(true);
      toast.success(`Certificate sent via WhatsApp`);
    } catch (error) {
      console.error("WhatsApp sending failed:", error);
      const message = error instanceof Error ? error.message : "Failed to send via WhatsApp";
      toast.error(message);
    } finally {
      setSendingWhatsApp(false);
    }
  };

  const handleToggleWhatsAppForm = () => {
    setShowWhatsAppForm(!showWhatsAppForm);
    if (showWhatsAppForm) {
      setWhatsAppPhone("");
      setWhatsAppSent(false);
    }
  };

  const handleExportCSV = async () => {
    if (!user) { toast.error("Not logged in"); return; }
    if (!navigator.onLine) { toast.error("Export requires an internet connection"); return; }
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
    if (!navigator.onLine) { toast.error("Export requires an internet connection"); return; }
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

  const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">PDF Certificate</h2>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />Generate Certificate</CardTitle>
          <CardDescription>Generate the EICR/EIC certificate PDF for {job.address}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            <p>Certificate will include:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>{job.circuits.length} circuits</li>
              <li>{job.observations.length} observations</li>
              <li>Board information</li>
              <li>Test results and schedule</li>
            </ul>
          </div>
          {isOffline && (
            <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-md">
              <WifiOff className="h-4 w-4" />
              <span>PDF generation requires an internet connection</span>
            </div>
          )}
          <div className="flex gap-2">
            {supportsFilePicker && (
              <Button onClick={() => handleGenerate(true)} disabled={generating || isOffline} className="flex-1">
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <FolderOpen className="h-4 w-4 mr-2" />
                    Save As...
                  </>
                )}
              </Button>
            )}
            <Button onClick={() => handleGenerate(false)} disabled={generating || isOffline} variant={supportsFilePicker ? "outline" : "default"} className="flex-1">
              {generating && !supportsFilePicker ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  {supportsFilePicker ? "Download" : "Generate PDF"}
                </>
              )}
            </Button>
          </div>
          {generating && (
            <p className="text-sm text-muted-foreground text-center">
              Usually takes 5-10 seconds
            </p>
          )}
        </CardContent>
      </Card>

      {/* Send by Email Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" />Send by Email</CardTitle>
          <CardDescription>Email the certificate PDF directly to your client</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!showEmailForm ? (
            <Button onClick={handleToggleEmailForm} disabled={isOffline} variant="outline" className="w-full">
              <Mail className="h-4 w-4 mr-2" />
              Send by Email
            </Button>
          ) : (
            <div className="space-y-3">
              {emailSent ? (
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 p-3 rounded-md">
                  <CheckCircle className="h-4 w-4" />
                  <span>Certificate sent to {emailTo}</span>
                </div>
              ) : (
                <>
                  <div>
                    <label htmlFor="email-to" className="block text-sm font-medium mb-1">
                      Recipient Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="email-to"
                      type="email"
                      placeholder="client@example.com"
                      value={emailTo}
                      onChange={(e) => setEmailTo(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={sendingEmail}
                    />
                    {emailTo && !isValidEmail(emailTo) && (
                      <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        Please enter a valid email address
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="email-client-name" className="block text-sm font-medium mb-1">
                      Client Name <span className="text-muted-foreground text-xs">(optional)</span>
                    </label>
                    <input
                      id="email-client-name"
                      type="text"
                      placeholder="e.g. Mrs Smith"
                      value={emailClientName}
                      onChange={(e) => setEmailClientName(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={sendingEmail}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSendEmail}
                      disabled={sendingEmail || !emailTo || !isValidEmail(emailTo)}
                      className="flex-1"
                    >
                      {sendingEmail ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Sending...
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4 mr-2" />
                          Send Certificate
                        </>
                      )}
                    </Button>
                    <Button onClick={handleToggleEmailForm} variant="ghost" disabled={sendingEmail}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
              {emailSent && (
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setEmailSent(false);
                      setEmailTo("");
                      setEmailClientName("");
                    }}
                    variant="outline"
                    className="flex-1"
                  >
                    Send to Another
                  </Button>
                  <Button onClick={handleToggleEmailForm} variant="ghost">
                    Done
                  </Button>
                </div>
              )}
            </div>
          )}
          {isOffline && (
            <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-md">
              <WifiOff className="h-4 w-4" />
              <span>Sending email requires an internet connection</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Send via WhatsApp Card */}
      {whatsAppConfigured && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-green-600" />
              Send via WhatsApp
            </CardTitle>
            <CardDescription>Send the certificate PDF to your client via WhatsApp</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!showWhatsAppForm ? (
              <Button
                onClick={handleToggleWhatsAppForm}
                disabled={isOffline}
                className="w-full bg-green-600 hover:bg-green-700 text-white"
              >
                <MessageCircle className="h-4 w-4 mr-2" />
                Send via WhatsApp
              </Button>
            ) : (
              <div className="space-y-3">
                {whatsAppSent ? (
                  <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 p-3 rounded-md">
                    <CheckCircle className="h-4 w-4" />
                    <span>Certificate sent via WhatsApp</span>
                  </div>
                ) : (
                  <>
                    <div>
                      <label htmlFor="whatsapp-phone" className="block text-sm font-medium mb-1">
                        Phone Number <span className="text-red-500">*</span>
                      </label>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                          id="whatsapp-phone"
                          type="tel"
                          placeholder="07700 900123"
                          value={whatsAppPhone}
                          onChange={(e) => setWhatsAppPhone(e.target.value)}
                          className="w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={sendingWhatsApp}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        UK mobile number: 07xxx, +447xxx, or 447xxx
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={handleSendWhatsApp}
                        disabled={sendingWhatsApp || !whatsAppPhone}
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                      >
                        {sendingWhatsApp ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4 mr-2" />
                            Send Certificate
                          </>
                        )}
                      </Button>
                      <Button onClick={handleToggleWhatsAppForm} variant="ghost" disabled={sendingWhatsApp}>
                        Cancel
                      </Button>
                    </div>
                  </>
                )}
                {whatsAppSent && (
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        setWhatsAppSent(false);
                        setWhatsAppPhone("");
                      }}
                      variant="outline"
                      className="flex-1"
                    >
                      Send to Another
                    </Button>
                    <Button onClick={handleToggleWhatsAppForm} variant="ghost">
                      Done
                    </Button>
                  </div>
                )}
              </div>
            )}
            {isOffline && (
              <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-md">
                <WifiOff className="h-4 w-4" />
                <span>WhatsApp sending requires an internet connection</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Export Data Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" />Export Data</CardTitle>
          <CardDescription>Download job data as CSV or Excel for external use</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            <ul className="list-disc list-inside space-y-1">
              <li><strong>CSV</strong> -- Circuit schedule data (all {job.circuits.length} circuits)</li>
              <li><strong>Excel</strong> -- Full workbook with circuits, observations, board info, installation details, and supply characteristics</li>
            </ul>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleExportCSV} disabled={exportingCSV || isOffline} variant="outline" className="flex-1">
              {exportingCSV ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Table className="h-4 w-4 mr-2" />
                  Export CSV
                </>
              )}
            </Button>
            <Button onClick={handleExportExcel} disabled={exportingExcel || isOffline} variant="outline" className="flex-1">
              {exportingExcel ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  Export Excel
                </>
              )}
            </Button>
          </div>
          {isOffline && (
            <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-md">
              <WifiOff className="h-4 w-4" />
              <span>Export requires an internet connection</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
