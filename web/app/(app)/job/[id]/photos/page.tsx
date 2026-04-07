'use client';

import { useState } from 'react';
import { useJobContext } from '../layout';
import { PhotoGallery } from '@/components/photos/photo-gallery';
import { PhotoUpload } from '@/components/photos/photo-upload';

export default function PhotosPage() {
  const { job, user } = useJobContext();
  const [refreshKey, setRefreshKey] = useState(0);

  if (!user) return null;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Job Photos</h2>
        <PhotoUpload userId={user.id} jobId={job.id} onUpload={() => setRefreshKey((k) => k + 1)} />
      </div>
      <PhotoGallery userId={user.id} jobId={job.id} refreshKey={refreshKey} />
    </div>
  );
}
