"use client";
import { useModel } from "@/components/model-provider";
import { Card, ConfidenceBadge, Loading, PageHeader, SourceBadge } from "@/components/ui";

export default function ProfilePage() {
  const { evaluated, replaceModel } = useModel();
  if (!evaluated) return <Loading />;
  const { model } = evaluated;
  const p = model.profile;
  return (
    <div>
      <PageHeader title="System profile" lede="Who and what the model describes. The MVP supports individual and household systems; the schema already carries organization and country so they can be added without a rewrite." />
      <Card>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>
            <input
              type="text"
              className="w-full max-w-md"
              value={p.name}
              onChange={(e) => replaceModel({ ...model, profile: { ...p, name: e.target.value } })}
            />
          </dd>
          <dt className="text-muted">System type</dt>
          <dd>
            <select
              value={p.systemType}
              onChange={(e) =>
                replaceModel({ ...model, profile: { ...p, systemType: e.target.value as typeof p.systemType } })
              }
            >
              <option value="individual">individual</option>
              <option value="household">household</option>
              <option value="organization" disabled>
                organization (not yet supported)
              </option>
              <option value="country" disabled>
                country (not yet supported)
              </option>
            </select>
          </dd>
          <dt className="text-muted">Location</dt>
          <dd>{p.location || "—"}</dd>
          <dt className="text-muted">Currency</dt>
          <dd>{p.currency}</dd>
          <dt className="text-muted">Description</dt>
          <dd>
            <textarea
              className="w-full max-w-xl"
              rows={3}
              value={p.description}
              onChange={(e) => replaceModel({ ...model, profile: { ...p, description: e.target.value } })}
            />
          </dd>
          <dt className="text-muted">Members</dt>
          <dd>
            <ul>
              {p.members.map((m, i) => (
                <li key={i}>
                  {m.label} <span className="text-muted">— {m.role}</span>
                </li>
              ))}
            </ul>
          </dd>
        </dl>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <Card tone="current" title="Current attractor (as described)">
          <p className="text-sm">{model.currentAttractor.summary || "Not described yet."}</p>
          <div className="mt-2 flex gap-2">
            <SourceBadge sourceType={model.currentAttractor.sourceType} />
            <ConfidenceBadge confidence={model.currentAttractor.confidence} />
          </div>
        </Card>
        <Card tone="desired" title="Desired attractor (as described)">
          <p className="text-sm">{model.desiredAttractor.summary || "Not described yet."}</p>
          <div className="mt-2 flex gap-2">
            <SourceBadge sourceType={model.desiredAttractor.sourceType} />
            <ConfidenceBadge confidence={model.desiredAttractor.confidence} />
          </div>
        </Card>
      </div>
      <p className="text-xs text-muted mt-4">Model last saved: {new Date(model.updatedAt).toLocaleString()}</p>
    </div>
  );
}
