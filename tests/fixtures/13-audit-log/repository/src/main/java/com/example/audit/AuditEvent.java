package com.example.audit;

public record AuditEvent(String actor, String action, String resource) {
  public void publish() {
    // The fixture models the framework boundary; persistence is outside this static evidence repository.
  }
}
