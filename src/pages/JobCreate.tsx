import { useNavigate } from 'react-router';

export default function JobCreatePage() {
  const navigate = useNavigate();

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-4">Create Job</h1>

      <div className="rounded-lg border p-6">
        <p className="text-muted-foreground mb-4">
          Job creation form coming soon.
        </p>

        <button
          className="rounded bg-primary px-4 py-2 text-white"
          onClick={() => navigate('/jobs')}
        >
          Back to Jobs
        </button>
      </div>
    </div>
  );
}
