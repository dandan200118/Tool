import { config } from "../../../../config";
import { ForbiddenError } from "../../../../shared/errors";
import { getModelFamilyForRequest } from "../../../../shared/models";
import { HPMRequestCallback } from "../index";

/**
 * Ensures the selected model family is enabled by the proxy configuration.
 */
export const checkModelFamily: HPMRequestCallback = (_proxyReq, req) => {
  const family = getModelFamilyForRequest(req);
  if (!config.allowedModelFamilies.includes(family)) {
    throw new ForbiddenError(
      `Model family '${family}' is not enabled on this proxy`
    );
  }
};
