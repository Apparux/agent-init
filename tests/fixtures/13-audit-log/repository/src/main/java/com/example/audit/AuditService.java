package com.example.audit;

public final class AuditService {
  public AuditEvent record(String actor, String action, String resource) {
    AuditEvent event = new AuditEvent(actor, action, resource);
    event.publish();
    return event;
  }
}
