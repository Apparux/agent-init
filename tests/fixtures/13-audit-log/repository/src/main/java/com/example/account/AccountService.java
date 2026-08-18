package com.example.account;

import com.example.audit.AuditService;

public final class AccountService {
  private final AuditService auditService = new AuditService();

  public void closeAccount(String actor, String accountId) {
    auditService.record(actor, "close-account", accountId);
  }
}
